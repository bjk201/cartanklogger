import os
import yaml
import json
import sqlite3
import requests
from datetime import datetime, timedelta
from flask import Flask, render_template, jsonify, request
import pandas as pd

app = Flask(__name__)

# Load configuration
def load_config():
    config_path = os.environ.get('CONFIG_PATH', '/app/config.yaml')
    with open(config_path, 'r') as f:
        return yaml.safe_load(f)

config = load_config()

# EVCC API client
class EVCCClient:
    def __init__(self, host, port, api_endpoint):
        self.base_url = f"http://{host}:{port}{api_endpoint}"
    
    def get_charging_sessions(self, days=30):
        """Get charging sessions from EVCC"""
        try:
            # EVCC HTTP API endpoint for charging data
            response = requests.get(f"{self.base_url}?data=charge&format=json", timeout=10)
            if response.status_code == 200:
                data = response.json()
                # Process EVCC data format
                sessions = []
                if isinstance(data, dict) and 'charge' in data:
                    for session in data['charge']:
                        sessions.append({
                            'timestamp': session.get('timestamp', 0),
                            'energy_kwh': session.get('energy', 0),
                            'power_kw': session.get('power', 0),
                            'source': session.get('source', 'grid'),  # pv, grid
                            'price_per_kwh': session.get('price', 0)  # EVCC already calculates price
                        })
                return sessions
            else:
                app.logger.error(f"EVCC API error: {response.status_code}")
                return []
        except Exception as e:
            app.logger.error(f"Error fetching EVCC data: {e}")
            return []

# TeslaMate database client
class TeslaMateClient:
    def __init__(self, db_path='/app/data/teslamate.db'):
        self.db_path = db_path
    
    def get_charging_sessions(self, days=30):
        """Get charging sessions from TeslaMate database"""
        if not os.path.exists(self.db_path):
            app.logger.warning(f"TeslaMate database not found at {self.db_path}")
            return []
        
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # TeslaMate schema for charging sessions
            query = """
            SELECT 
                c.id,
                c.started_at,
                c.ended_at,
                c.energy_added,
                c.distance,
                c.charge_energy_added,
                c.price_energy,
                c.price_total,
                l.name as location_name
            FROM charging_sessions c
            LEFT JOIN locations l ON c.location_id = l.id
            WHERE c.started_at >= datetime('now', ?)
            ORDER BY c.started_at DESC
            """
            
            cursor.execute(query, (f'-{days} days',))
            rows = cursor.fetchall()
            
            sessions = []
            for row in rows:
                sessions.append({
                    'id': row[0],
                    'timestamp': int(datetime.strptime(row[1], '%Y-%m-%d %H:%M:%S').timestamp()),
                    'ended_at': int(datetime.strptime(row[2], '%Y-%m-%d %H:%M:%S').timestamp()) if row[2] else 0,
                    'energy_kwh': float(row[3]) if row[3] else 0,
                    'distance_km': float(row[4]) if row[4] else 0,
                    'charge_energy_added': float(row[5]) if row[5] else 0,
                    'price_energy': float(row[6]) if row[6] else 0,
                    'price_total': float(row[7]) if row[7] else 0,
                    'location_name': row[8] or 'Unknown',
                    'source': 'tesla'  # Default source for Tesla
                })
            
            conn.close()
            return sessions
        except Exception as e:
            app.logger.error(f"Error fetching TeslaMate data: {e}")
            return []

# Data processor for cost calculations
class ChargingDataProcessor:
    def __init__(self, config):
        self.config = config
        self.pricing = config.get('pricing', {})
        self.pv_price = self.pricing.get('pv_price_per_kwh', 0.20)
        self.grid_price = self.pricing.get('grid_price_per_kwh', 0.30)
        self.external_price = self.pricing.get('external_price_per_kwh', 0.35)
    
    def calculate_cost(self, energy_kwh, source, location_name=''):
        """Calculate cost based on source and pricing"""
        # Check if it's external charging (TeslaMate location not home/work)
        if source == 'tesla' and location_name and location_name.lower() not in ['home', 'work', 'garage']:
            return energy_kwh * self.external_price
        
        if source == 'pv':
            return energy_kwh * self.pv_price
        elif source == 'grid':
            return energy_kwh * self.grid_price
        else:
            # Default to grid price for unknown sources
            return energy_kwh * self.grid_price
    
    def process_sessions(self, evcc_sessions, teslamate_sessions):
        """Process and combine sessions from both sources"""
        all_sessions = []
        
        # Process EVCC sessions
        for session in evcc_sessions:
            timestamp = datetime.fromtimestamp(session['timestamp'])
            cost = self.calculate_cost(
                session['energy_kwh'], 
                session.get('source', 'grid')
            )
            all_sessions.append({
                'timestamp': timestamp,
                'date': timestamp.date(),
                'energy_kwh': session['energy_kwh'],
                'source': session.get('source', 'grid'),
                'location': 'Home (EVCC)',
                'cost': cost,
                'price_per_kwh': cost / session['energy_kwh'] if session['energy_kwh'] > 0 else 0,
                'distance_km': 0,  # EVCC doesn't typically provide distance
                'source_system': 'evcc'
            })
        
        # Process TeslaMate sessions
        for session in teslamate_sessions:
            timestamp = datetime.fromtimestamp(session['timestamp'])
            # Use TeslaMate's calculated price if available, else calculate
            if session['price_total'] > 0:
                cost = session['price_total']
                price_per_kwh = session['price_energy'] if session['energy_kwh'] > 0 else 0
            else:
                cost = self.calculate_cost(
                    session['energy_kwh'], 
                    session['source'],
                    session.get('location_name', '')
                )
                price_per_kwh = cost / session['energy_kwh'] if session['energy_kwh'] > 0 else 0
            
            all_sessions.append({
                'timestamp': timestamp,
                'date': timestamp.date(),
                'energy_kwh': session['energy_kwh'],
                'source': session['source'],
                'location': session.get('location_name', 'Unknown'),
                'cost': cost,
                'price_per_kwh': price_per_kwh,
                'distance_km': session.get('distance_km', 0),
                'source_system': 'teslamate'
            })
        
        return sorted(all_sessions, key=lambda x: x['timestamp'])

# Initialize clients
evcc_client = EVCCClient(
    config['evcc']['host'],
    config['evcc']['port'],
    config['evcc']['api_endpoint']
)

teslamate_client = TeslaMateClient('/app/data/teslamate.db')
processor = ChargingDataProcessor(config)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/sessions')
def get_sessions():
    days = request.args.get('days', 30, type=int)
    
    # Get data from both sources
    evcc_sessions = evcc_client.get_charging_sessions(days)
    teslamate_sessions = teslamate_client.get_charging_sessions(days)
    
    # Process and combine
    all_sessions = processor.process_sessions(evcc_sessions, teslamate_sessions)
    
    # Convert to JSON-serializable format
    json_sessions = []
    for session in all_sessions:
        json_sessions.append({
            'timestamp': session['timestamp'].isoformat(),
            'date': session['date'].isoformat(),
            'energy_kwh': round(session['energy_kwh'], 2),
            'source': session['source'],
            'location': session['location'],
            'cost': round(session['cost'], 2),
            'price_per_kwh': round(session['price_per_kwh'], 2),
            'distance_km': round(session['distance_km'], 1),
            'source_system': session['source_system']
        })
    
    return jsonify(json_sessions)

@app.route('/api/summary')
def get_summary():
    days = request.args.get('days', 30, type=int)
    
    # Get data from both sources
    evcc_sessions = evcc_client.get_charging_sessions(days)
    teslamate_sessions = teslamate_client.get_charging_sessions(days)
    
    # Process and combine
    all_sessions = processor.process_sessions(evcc_sessions, teslamate_sessions)
    
    if not all_sessions:
        return jsonify({
            'total_energy_kwh': 0,
            'total_cost': 0,
            'avg_price_per_kwh': 0,
            'total_distance_km': 0,
            'energy_by_source': {},
            'cost_by_source': {},
            'daily_data': [],
            'monthly_data': []
        })
    
    # Calculate totals
    total_energy = sum(s['energy_kwh'] for s in all_sessions)
    total_cost = sum(s['cost'] for s in all_sessions)
    total_distance = sum(s['distance_km'] for s in all_sessions)
    avg_price = total_cost / total_energy if total_energy > 0 else 0
    
    # Group by source
    energy_by_source = {}
    cost_by_source = {}
    for session in all_sessions:
        source = session['source']
        energy_by_source[source] = energy_by_source.get(source, 0) + session['energy_kwh']
        cost_by_source[source] = cost_by_source.get(source, 0) + session['cost']
    
    # Daily aggregation
    daily_data = {}
    for session in all_sessions:
        date_str = session['date'].isoformat()
        if date_str not in daily_data:
            daily_data[date_str] = {'energy': 0, 'cost': 0, 'distance': 0}
        daily_data[date_str]['energy'] += session['energy_kwh']
        daily_data[date_str]['cost'] += session['cost']
        daily_data[date_str]['distance'] += session['distance_km']
    
    daily_list = [{'date': date, **values} for date, values in daily_data.items()]
    daily_list.sort(key=lambda x: x['date'])
    
    # Monthly aggregation (for current month)
    now = datetime.now()
    monthly_data = {}
    for session in all_sessions:
        if session['timestamp'].year == now.year and session['timestamp'].month == now.month:
            week_key = session['timestamp'].strftime('%Y-W%U')  # Year-Week
            if week_key not in monthly_data:
                monthly_data[week_key] = {'energy': 0, 'cost': 0, 'distance': 0}
            monthly_data[week_key]['energy'] += session['energy_kwh']
            monthly_data[week_key]['cost'] += session['cost']
            monthly_data[week_key]['distance'] += session['distance_km']
    
    monthly_list = [{'week': week, **values} for week, values in monthly_data.items()]
    monthly_list.sort(key=lambda x: x['week'])
    
    return jsonify({
        'total_energy_kwh': round(total_energy, 2),
        'total_cost': round(total_cost, 2),
        'avg_price_per_kwh': round(avg_price, 2),
        'total_distance_km': round(total_distance, 1),
        'energy_by_source': {k: round(v, 2) for k, v in energy_by_source.items()},
        'cost_by_source': {k: round(v, 2) for k, v in cost_by_source.items()},
        'daily_data': daily_list,
        'monthly_data': monthly_list,
        'cost_per_km': round(total_cost / total_distance, 2) if total_distance > 0 else 0,
        'energy_per_km': round(total_energy / total_distance, 2) if total_distance > 0 else 0
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)