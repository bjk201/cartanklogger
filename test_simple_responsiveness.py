#!/usr/bin/env python3
"""
Simple CarTankLogger Responsiveness Test

Quick script to test if all pages are accessible and basic structure exists.
"""
import requests
import time
import json

def test_page(base_url, path):
    try:
        response = requests.get(f"{base_url}{path}", timeout=10)
        html = response.text
        
        # Basic checks
        checks = {
            'has_body': '<body' in html.lower(),
            'has_main': '<main' in html.lower(),
            'has_container': 'container-fluid' in html.lower(),
            'has_row': 'row' in html.lower(),
            'has_col': 'col-' in html.lower(),
            'has_script': '<script' in html.lower(),
            'has_css': 'stylesheet' in html.lower()
        }
        
        return {
            'success': response.status_code == 200,
            'status_code': response.status_code,
            'page_size': len(html),
            'checks': checks,
            'all_checks_pass': all(checks.values())
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'checks': {},
            'all_checks_pass': False
        }

def main():
    base_url = "http://localhost:5000"
    pages = [
        ("/", "Overview"),
        ("/statistik", "Statistics"),
        ("/monatsvergleich", "Month Comparison"),
        ("/evcc", "EVCC"),
        ("/teslamate", "TeslaMate"),
        ("/admin", "Admin")
    ]
    
    print("Testing CarTankLogger Responsiveness...")
    print(f"Base URL: {base_url}")
    print()
    
    results = {}
    passed = 0
    total = 0
    
    for path, name in pages:
        print(f"Testing {name} ({path})...")
        result = test_page(base_url, path)
        results[name] = result
        
        if result['success'] and result['all_checks_pass']:
            print(f"  ✅ PASSED - Status: {result['status_code']}, Size: {result['page_size']} bytes")
            passed += 1
        else:
            print(f"  ❌ FAILED - Status: {result.get('status_code', 'N/A')}")
            if 'error' in result:
                print(f"     Error: {result['error']}")
            else:
                failed_checks = [k for k, v in result['checks'].items() if not v]
                print(f"     Failed checks: {failed_checks}")
        
        total += 1
        print()
    
    print("=== Summary ===")
    print(f"Total pages tested: {total}")
    print(f"Passed: {passed}")
    print(f"Failed: {total - passed}")
    
    # Save results
    with open('responsiveness-results.json', 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"Results saved to: responsiveness-results.json")
    
    if passed == total:
        print("🎉 All pages loaded successfully!")
        return 0
    else:
        print("⚠️  Some pages failed to load or have issues.")
        return 1

if __name__ == "__main__":
    exit(main())