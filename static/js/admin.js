// admin.js - Admin Einstellungen für CarTankLogger

$(function() {
    // CSRF-Token holen
    function getCsrfToken() {
        return $('meta[name="csrf-token"]').attr('content') || '';
    }
    
    // CSRF-Fetch Wrapper
    async function csrfFetch(url, opts = {}) {
        const csrf = getCsrfToken();
        opts.headers = opts.headers || {};
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['X-CSRFToken'] = csrf;
        opts.credentials = 'same-origin';
        return fetch(url, opts);
    }
    
    // Konfiguration laden
    async function loadConfig() {
        try {
            const resp = await fetch('/api/config', {credentials: 'same-origin'});
            const c = await resp.json();
            
            // EVCC Settings
            if (c.evcc) {
                $('input[name="evcc_url"]').val(c.evcc.url || '');
                $('input[name="evcc_interval"]').val(c.evcc.interval || '');
            }
            
            // TeslaMate Settings
            if (c.teslamate) {
                $('input[name="teslamate_url"]').val(c.teslamate.url || '');
                $('input[name="teslamate_api_token"]').val(c.teslamate.api_token || '');
            }
            
            // App Settings
            if (c.app) {
                $('input[name="home_addresses"]').val((c.app.home_addresses || []).join(', '));
            }
            
            // Pricing Defaults
            if (c.pricing_defaults) {
                $('input[name="evcc_price_day"]').val(c.pricing_defaults.evcc_price_day || '');
                $('input[name="evcc_price_night"]').val(c.pricing_defaults.evcc_price_night || '');
                $('input[name="teslamate_price"]').val(c.pricing_defaults.teslamate_price || '');
            }
        } catch (e) {
            console.error('Config laden fehlgeschlagen:', e);
        }
    }
    
    // Konfiguration speichern
    async function saveConfig() {
        const config = {};
        
        // EVCC Settings
        config.evcc = {
            url: $('input[name="evcc_url"]').val() || '',
            interval: $('input[name="evcc_interval"]').val() || ''
        };
        
        // TeslaMate Settings
        config.teslamate = {
            url: $('input[name="teslamate_url"]').val() || '',
            api_token: $('input[name="teslamate_api_token"]').val() || ''
        };
        
        // App Settings
        config.app = {
            home_addresses: $('input[name="home_addresses"]').val().split(',').map(s => s.trim()).filter(s => s)
        };
        
        // Pricing Defaults
        config.pricing_defaults = {
            evcc_price_day: parseFloat($('input[name="evcc_price_day"]').val()) || 0,
            evcc_price_night: parseFloat($('input[name="evcc_price_night"]').val()) || 0,
            teslamate_price: parseFloat($('input[name="teslamate_price"]').val()) || 0
        };
        
        try {
            const resp = await csrfFetch('/api/config', {
                method: 'POST',
                body: JSON.stringify(config)
            });
            const result = await resp.json();
            
            if (result.ok) {
                showToast('✅ Einstellungen gespeichert');
                setTimeout(loadConfig, 500); // Refresh nach kurzer Verzögerung
            } else {
                showToast('❌ Fehler: ' + (result.error || 'unbekannt'));
            }
        } catch (e) {
            showToast('❌ Fehler: ' + e.message);
        }
    }
    
    // Toast-Anzeige
    function showToast(msg) {
        let toast = $('#toast');
        if (!toast.length) {
            toast = $('<div id="toast" class="toast align-items-center text-bg-primary border-0 position-fixed bottom-0 end-0 m-3" role="alert"></div>');
            $('body').append(toast);
        }
        toast.text(msg);
        const bsToast = new bootstrap.Toast(toast[0], {delay: 3000});
        bsToast.show();
    }
    
    // Event-Handler für Save-Button
    $('#saveConfigBtn').on('click', saveConfig);
    
    // Initial laden
    loadConfig();
});