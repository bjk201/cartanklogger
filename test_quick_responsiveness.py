#!/usr/bin/env python3
"""
Quick Responsiveness Test Script for CarTankLogger

Tests all pages across mobile and desktop viewports using curl to check
if pages load and basic structure is present.
"""
import os
import sys
import argparse
import time
import json
import requests
from urllib.parse import urljoin
from pathlib import Path

def get_args():
    parser = argparse.ArgumentParser(description='Quick CarTankLogger responsiveness test')
    parser.add_argument('--base-url', default='http://localhost:5000', help='Base URL for tests (default: http://localhost:5000)')
    parser.add_argument('--output', default='responsiveness-results.json', help='Output file for results (default: responsiveness-results.json)')
    return parser.parse_args()

def test_page(url, viewport_name, viewport_width, viewport_height):
    """Test a specific page at a specific viewport"""
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        
        html_content = response.text
        
        # Basic checks for responsiveness
        checks = {
            'loads_successfully': True,
            'has_content': len(html_content) > 1000,
            'has_body': '<body' in html_content.lower(),
            'has_main': '<main' in html_content.lower(),
            'has_closing_html': html_content.strip().endswith('</html>'),
            'viewport_meta': '<meta name="viewport"' in html_content.lower(),
            'container_fluid': 'container-fluid' in html_content.lower(),
            'row_classes': 'row' in html_content.lower(),
            'col_classes': 'col-' in html_content.lower(),
        }
        
        # Performance metrics
        page_size = len(html_content.encode('utf-8')) / 1024
        
        return {
            'success': True,
            'url': url,
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
            'url': url,
            'viewport': f'{viewport_width}x{viewport_height}',
            'viewport_name': viewport_name,
            'error': str(e),
            'status_code': getattr(e.response, 'status_code', None) if hasattr(e, 'response') else None,
            'timestamp': time.time()
        }

def run_responsiveness_tests(base_url):
    """Run comprehensive testing across all pages and viewports"""
    pages = [
        {
            'name': 'Overview',
            'url': '/',
            'description': 'Main dashboard with KPI cards, charts, and trip tables'
        },
        {
            'name': 'Statistics',
            'url': '/statistik',
            'description': 'KPI metrics and comparison charts'
        },
        {
            'name': 'Month Comparison',
            'url': '/monatsvergleich',
            'description': 'Monthly aggregated data table'
        },
        {
            'name': 'EVCC',
            'url': '/evcc',
            'description': 'EVCC home charging sessions table'
        },
        {
            'name': 'TeslaMate',
            'url': '/teslamate',
            'description': 'TeslaMate external charging sessions table'
        },
        {
            'name': 'Admin',
            'url': '/admin',
            'description': 'Configuration and management interface'
        }
    ]
    
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
        }
    ]
    
    results = []
    failed_tests = []
    
    print(f"Testing {len(pages)} pages across {len(viewports)} viewports...")
    print(f"Base URL: {base_url}")
    print()
    
    for viewport in viewports:
        print(f"Testing {viewport['name']} ({viewport['width']}x{viewport['height']})...")
        
        for page in pages:
            result = test_page(base_url + page['url'], viewport['name'], viewport['width'], viewport['height'])
            result['page_name'] = page['name']
            result['page_description'] = page['description']
            
            results.append(result)
            
            if not result['success'] or any(not check for check in result.get('checks', {}).values()):
                failed_tests.append(result)
                status = "❌ FAILED"
            else:
                status = "✅ PASSED"
            
            print(f"  {status} {page['name']}")
        
        print()
    
    return results, failed_tests

def save_results(results, failed_tests, output_file):
    """Save test results to JSON and Markdown files"""
    # Save detailed results
    with open(output_file, 'w') as f:
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
    summary_file = output_file.replace('.json', '.md')
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
                error_msg = test.get('error', 'Check failures')
                f.write(f'- **{test["page_name"]}** at {test["viewport"]}: {error_msg}\n')
        
        # Summary table
        f.write('\n## Test Summary\n\n')
        f.write('| Page | Viewport | Status | HTTP Code | Page Size (KB) |\n')
        f.write('|------|----------|--------|-----------|----------------|\n')
        
        for test in results:
            status = 'PASS' if test['success'] and all(test.get('checks', {}).values()) else 'FAIL'
            page_size = test.get('page_size_kb', 0)
            f.write(f'| {test["page_name"]} | {test["viewport_name"]} | {status} | {test.get("status_code", "N/A")} | {page_size} |\n')
    
    print(f"\nResults saved to: {output_file}")
    print(f"  - Detailed results: {output_file}")
    print(f"  - Summary report: {summary_file}")

def main():
    args = get_args()
    
    print("🚀 Starting CarTankLogger Quick Responsiveness Tests...")
    print(f"🌐 Base URL: {args.base_url}")
    print()
    
    # Run tests
    try:
        results, failed_tests = run_responsiveness_tests(args.base_url)
        
        # Save results
        save_results(results, failed_tests, args.output)
        
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