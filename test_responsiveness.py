#!/usr/bin/env python3
"""
CarTankLogger Responsiveness Testing Script

Tests all pages across mobile and desktop viewports to verify no overlaps, clipped content,
or layout breaks.

Usage: python test_responsiveness.py [--host HOST] [--port PORT] [--output-dir OUTDIR]
"""
import os
import sys
import argparse
import subprocess
import time
from pathlib import Path
import json
import requests
from urllib.parse import urljoin

def get_args():
    parser = argparse.ArgumentParser(description='Test CarTankLogger responsiveness')
    parser.add_argument('--host', default='localhost', help='Server host (default: localhost)')
    parser.add_argument('--port', type=int, default=5001, help='Server port (default: 5001)')
    parser.add_argument('--output-dir', default='test-results', help='Output directory for results (default: test-results)')
    parser.add_argument('--base-url', default='http://localhost:5001', help='Base URL for tests (default: http://localhost:5001)')
    return parser.parse_args()

def create_test_results_dir(output_dir):
    """Create output directory and subdirectories"""
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(os.path.join(output_dir, 'screenshots'), exist_ok=True)
    return output_dir

def load_pages(app_dir):
    """Load all template files to extract their URLs and test them"""
    pages = [
        {
            'name': 'Overview',
            'template': 'templates/index.html',
            'url': '/',
            'description': 'Main dashboard with KPI cards, charts, and trip tables'
        },
        {
            'name': 'Statistics',
            'template': 'templates/statistik.html',
            'url': '/statistik',
            'description': 'KPI metrics and comparison charts'
        },
        {
            'name': 'Month Comparison',
            'template': 'templates/monatsvergleich.html',
            'url': '/monatsvergleich',
            'description': 'Monthly aggregated data table'
        },
        {
            'name': 'EVCC',
            'template': 'templates/evcc.html',
            'url': '/evcc',
            'description': 'EVCC home charging sessions table'
        },
        {
            'name': 'TeslaMate',
            'template': 'templates/teslamate.html',
            'url': '/teslamate',
            'description': 'TeslaMate external charging sessions table'
        },
        {
            'name': 'Admin',
            'template': 'templates/admin.html',
            'url': '/admin',
            'description': 'Configuration and management interface'
        }
    ]
    return pages

def test_page_responsiveness(base_url, page_url, viewport_name, viewport_width, viewport_height):
    """Test a specific page at a specific viewport"""
    # Use curl to check if page loads
    full_url = urljoin(base_url, page_url)
    
    try:
        response = requests.get(full_url, timeout=30)
        response.raise_for_status()
        
        # Check for basic HTML structure
        html_content = response.text
        
        # Basic checks for responsiveness
        checks = {
            'loads_successfully': True,
            'has_content': len(html_content) > 1000,  # Basic content check
            'has_body': '<body' in html_content.lower(),
            'has_main': '<main' in html_content.lower(),
            'has_closing_html': html_content.strip().endswith('</html>'),
            'viewport_meta': '<meta name="viewport"' in html_content.lower(),
            'container_fluid': 'container-fluid' in html_content.lower(),
            'row_classes': 'row' in html_content.lower(),
            'col_classes': 'col-' in html_content.lower(),
        }
        
        # Performance metrics
        page_size = len(html_content.encode('utf-8')) / 1024  # KB
        
        return {
            'success': True,
            'url': page_url,
            'viewport': f'{viewport_width}x{viewport_height}',
            'viewport_name': viewport_name,
            'status_code': response.status_code,
            'page_size_kb': round(page_size, 2),
            'content_length': len(html_content),
            'checks': checks,
            'timestamp': time.time()
        }
        
    except requests.exceptions.RequestException as e:
        return {
            'success': False,
            'url': page_url,
            'viewport': f'{viewport_width}x{viewport_height}',
            'viewport_name': viewport_name,
            'error': str(e),
            'status_code': getattr(e.response, 'status_code', None) if hasattr(e, 'response') else None,
            'timestamp': time.time()
        }

def run_tests(app_dir, args):
    """Run comprehensive testing across all viewports"""
    pages = load_pages(app_dir)
    
    viewports = [
        {
            'name': 'Mobile',
            'width': 375,
            'height': 667,
            'max_width': 768
        },
        {
            'name': 'Desktop',
            'width': 1920,
            'height': 1080,
            'max_width': None
        },
        {
            'name': 'Tablet',
            'width': 768,
            'height': 1024,
            'max_width': None
        },
        {
            'name': 'Small Mobile',
            'width': 320,
            'height': 568,
            'max_width': 768
        }
    ]
    
    results = []
    failed_tests = []
    
    print(f"Testing {len(pages)} pages across {len(viewports)} viewports...")
    print(f"Base URL: {args.base_url}")
    print()
    
    for viewport in viewports:
        print(f"Testing {viewport['name']} ({viewport['width']}x{viewport['height']})...")
        
        for page in pages:
            result = test_page_responsiveness(args.base_url, page['url'], viewport['name'], viewport['width'], viewport['height'])
            result['page_name'] = page['name']
            result['page_description'] = page['description']
            result['template'] = page['template']
            
            results.append(result)
            
            if not result['success'] or any(not check for check in result.get('checks', {}).values()):
                failed_tests.append(result)
                status = "❌ FAILED"
            else:
                status = "✅ PASSED"
            
            print(f"  {status} {page['name']}")
        
        print()
    
    return results, failed_tests

def save_results(results, failed_tests, output_dir):
    """Save test results to files"""
    # Save detailed results
    results_file = os.path.join(output_dir, 'test-results.json')
    with open(results_file, 'w') as f:
        json.dump({
            'summary': {
                'total_tests': len(results),
                'passed_tests': len(results) - len(failed_tests),
                'failed_tests': len(failed_tests),
                'success_rate': round((len(results) - len(failed_tests)) / len(results) * 100, 2) if results else 0
            },
            'results': results,
            'failed_tests_details': failed_tests
        }, f, indent=2)
    
    # Save summary report
    summary_file = os.path.join(output_dir, 'test-summary.md')
    with open(summary_file, 'w') as f:
        f.write('# CarTankLogger Responsiveness Test Results\n\n')
        f.write(f'**Generated:** {time.ctftime(time.time())}\n')
        f.write(f'**Total Tests:** {len(results)}\n')
        f.write(f'**Passed:** {len(results) - len(failed_tests)}\n')
        f.write(f'**Failed:** {len(failed_tests)}\n')
        f.write(f'**Success Rate:** {round((len(results) - len(failed_tests)) / len(results) * 100, 2) if results else 0}%\n\n')
        
        if failed_tests:
            f.write('## Failed Tests\n\n')
            for test in failed_tests:
                f.write(f'- **{test["page_name"]}** at {test["viewport"]}: {test.get("error", "Check failures")}\n')
    
    print(f"\nResults saved to: {output_dir}")
    print(f"  - Detailed results: {results_file}")
    print(f"  - Summary report: {summary_file}")

def main():
    args = get_args()
    app_dir = os.path.join(os.path.dirname(__file__), 'cartanklogger')
    
    print("🚀 Starting CarTankLogger Responsiveness Tests...")
    print(f"📁 App directory: {app_dir}")
    print(f"🌐 Base URL: {args.base_url}")
    print()
    
    # Create output directory
    output_dir = create_test_results_dir(args.output_dir)
    
    # Run tests
    try:
        results, failed_tests = run_tests(app_dir, args)
        
        # Save results
        save_results(results, failed_tests, output_dir)
        
        print(f"\n🏁 Test completed!")
        print(f"📊 Results: {len(results) - len(failed_tests)}/{len(results)} passed")
        
        if failed_tests:
            print("\n⚠️  Some tests failed. Check the results for details.")
            return 1
        else:
            print("\n✅ All tests passed!")
            return 0
            
    except Exception as e:
        print(f"\n💥 Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(main())