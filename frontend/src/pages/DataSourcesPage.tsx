import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, Wifi, AlertCircle, CheckCircle, Loader2, Shield, Eye, EyeOff, Clock } from 'lucide-react';
import { LoadingState, ErrorState, EmptyState, PartialError } from '../components/StateViews';
import { api, type DataSourceConfigRead, type DataSourceConfigWrite, type DataSourceConfigTestRequest, type DataSourceConfigTestResponse, type DataSourceStatusResponse } from '../lib/apiClient';
import './DataSourcesPage.css';

export function DataSourcesPage() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<DataSourceConfigRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingEVCC, setTestingEVCC] = useState(false);
  const [testingTM, setTestingTM] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<{ 
    evcc?: DataSourceConfigTestResponse; 
    teslamateapi?: DataSourceConfigTestResponse 
  }>({ evcc: undefined, teslamateapi: undefined });
  
  // Form state
  const [form, setForm] = useState({
    host: '',
    port: 7070,
    password: '',
    api_token: '',
    use_tls: false,
    base_url: '',
    token: '',
  });
  
  // Password visibility
  const [showEVCCPassword, setShowEVCCPassword] = useState(false);
  const [showEVCCAPIToken, setShowEVCCAPIToken] = useState(false);
  const [showTMToken, setShowTMToken] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configResponse, statusResponse] = await Promise.all([
        api.getDataSourceConfig(),
        api.getDataSourceStatus().catch(() => null) // Optional, don't fail if status endpoint has issues
      ]);
      
      setConfig(configResponse);
      // Populate form with current config (passwords/tokens not returned by API)
      setForm({
        host: configResponse.evcc_host,
        port: configResponse.evcc_port,
        password: '',
        api_token: '',
        use_tls: configResponse.evcc_use_tls,
        base_url: configResponse.teslamateapi_base_url,
        token: '',
      });
      
      // Initialize test results from status endpoint (shows last known reachability)
      if (statusResponse) {
        setTestResults({
          evcc: {
            ok: true,
            source: 'evcc',
            status: {
              configured: configResponse.evcc_configured,
              reachable: statusResponse.evcc?.reachable ?? false,
              level: statusResponse.evcc?.level,
              status_code: statusResponse.evcc?.status_code,
              error: statusResponse.evcc?.error,
              data_error: statusResponse.evcc?.data_error,
              last_checked: statusResponse.timestamp
            }
          },
          teslamateapi: {
            ok: true,
            source: 'teslamateapi',
            status: {
              configured: configResponse.teslamateapi_configured,
              reachable: statusResponse.teslamateapi?.reachable ?? false,
              level: statusResponse.teslamateapi?.level,
              status_code: statusResponse.teslamateapi?.status_code,
              error: statusResponse.teslamateapi?.error,
              data_error: statusResponse.teslamateapi?.data_error,
              last_checked: statusResponse.timestamp
            }
          }
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Laden: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleInputChange = (field: string, value: string | number | boolean) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    
    try {
      const response = await api.saveDataSourceConfig(form);
      
      setSuccess('Konfiguration gespeichert');
      // Refetch to get updated computed fields
      await fetchConfig();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Speichern: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTestEVCC = async () => {
    setTestingEVCC(true);
    setTestResults(prev => ({ ...prev, evcc: undefined }));
    
    try {
      const testRequest: DataSourceConfigTestRequest = {
        source: 'evcc',
        host: form.host,
        port: form.port,
        password: form.password || undefined,
        api_token: form.api_token || undefined,
        use_tls: form.use_tls,
      };
      const response = await api.testDataSourceConnection(testRequest);
      setTestResults(prev => ({ ...prev, evcc: response }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setTestResults(prev => ({ ...prev, evcc: { ok: false, source: 'evcc', status: { configured: false, reachable: false, error: message } } }));
    } finally {
      setTestingEVCC(false);
    }
  };

  const handleTestTM = async () => {
    setTestingTM(true);
    setTestResults(prev => ({ ...prev, teslamateapi: undefined }));
    
    try {
      const testRequest: DataSourceConfigTestRequest = {
        source: 'teslamateapi',
        base_url: form.base_url,
        token: form.token || undefined,
      };
      const response = await api.testDataSourceConnection(testRequest);
      setTestResults(prev => ({ ...prev, teslamateapi: response }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setTestResults(prev => ({ ...prev, teslamateapi: { ok: false, source: 'teslamateapi', status: { configured: false, reachable: false, error: message } } }));
    } finally {
      setTestingTM(false);
    }
  };

  const getStatusBadge = (status: { configured: boolean; reachable: boolean; level?: string; status_code?: number; error?: string; data_error?: string; last_checked?: string } | undefined) => {
    if (!status) return <span className="status-badge status-badge--unknown">Nicht getestet</span>;
    if (!status.configured) return <span className="status-badge status-badge--not-configured">Nicht konfiguriert</span>;
    if (status.reachable && status.level === 'reachable') return <span className="status-badge status-badge--ok"><CheckCircle size={12} /> Erreichbar</span>;
    if (status.reachable && status.level === 'data_fetch_error') return <span className="status-badge status-badge--warn"><AlertCircle size={12} /> Erreichbar, Datenabruf fehlgeschlagen</span>;
    return <span className="status-badge status-badge--error"><AlertCircle size={12} /> Nicht erreichbar{status.error ? ` (${status.error})` : ''}</span>;
  };

  const formatLastChecked = (timestamp?: string) => {
    if (!timestamp) return '';
    try {
      return ` (zuletzt: ${new Date(timestamp).toLocaleString('de-DE')})`;
    } catch {
      return '';
    }
  };

  const PasswordInput = ({ value, onChange, show, toggleShow, placeholder, label, type = 'password' }: {
    value: string;
    onChange: (v: string) => void;
    show: boolean;
    toggleShow: () => void;
    placeholder: string;
    label: string;
    type?: 'password' | 'text';
  }) => (
    <div className="form-group">
      <label>{label}</label>
      <div className="password-input-wrapper">
        <input
          type={show ? 'text' : type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
        <button type="button" className="toggle-visibility" onClick={toggleShow} aria-label={show ? 'Verbergen' : 'Anzeigen'}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="page-container">
        <LoadingState message="Einstellungen werden geladen…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <ErrorState message={error} onRetry={fetchConfig} />
      </div>
    );
  }

  const isLive = config?.data_source === 'live';
  const evccConfigured = config?.evcc_configured || false;
  const tmConfigured = config?.teslamateapi_configured || false;

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Datenquellen</h1>
        <p className="page-subtitle">
          EVCC & TeslaMateAPI Konfiguration
          <span className={`mode-badge ${isLive ? 'mode-badge--live' : 'mode-badge--demo'}`}>
            {isLive ? 'LIVE' : 'DEMO'}
          </span>
        </p>
      </div>

      {success && <PartialError message={success} onDismiss={() => setSuccess(null)} />}

      {/* Current Status Overview */}
      <section className="settings-section">
        <h2 className="settings-section-title">Aktueller Status</h2>
        <div className="status-grid">
          <div className="status-card">
            <div className="status-card__label">Modus</div>
            <div className={`status-card__value ${isLive ? 'status-live' : 'status-demo'}`}>
              {isLive ? 'Live' : 'Demo / Fallback'}
            </div>
          </div>
          <div className="status-card">
            <div className="status-card__label">EVCC konfiguriert</div>
            <div className={`status-card__value ${evccConfigured ? 'status-ok' : 'status-warn'}`}>
              {evccConfigured ? 'Ja' : 'Nein'}
            </div>
          </div>
          <div className="status-card">
            <div className="status-card__label">EVCC erreichbar</div>
            <div className="status-card__value">
              {getStatusBadge(testResults.evcc?.status)}
              {formatLastChecked(testResults.evcc?.status?.last_checked)}
            </div>
          </div>
          <div className="status-card">
            <div className="status-card__label">TeslaMateAPI konfiguriert</div>
            <div className={`status-card__value ${tmConfigured ? 'status-ok' : 'status-warn'}`}>
              {tmConfigured ? 'Ja' : 'Nein'}
            </div>
          </div>
          <div className="status-card">
            <div className="status-card__label">TeslaMateAPI erreichbar</div>
            <div className="status-card__value">
              {getStatusBadge(testResults.teslamateapi?.status)}
              {formatLastChecked(testResults.teslamateapi?.status?.last_checked)}
            </div>
          </div>
        </div>
      </section>

      {/* EVCC Configuration */}
      <section className="settings-section">
        <h2 className="settings-section-title">
          <Shield size={20} /> EVCC (Home Charging)
        </h2>
        <div className="settings-form">
          <div className="form-row">
            <div className="form-group">
              <label>Host <span className="required">*</span></label>
              <input
                type="text"
                value={form.host}
                onChange={e => handleInputChange('host', e.target.value)}
                placeholder="z.B. evcc.local oder 192.168.1.100"
                required
              />
            </div>
            <div className="form-group">
              <label>Port</label>
              <input
                type="number"
                value={form.port}
                onChange={e => handleInputChange('port', parseInt(e.target.value) || 7070)}
                min={1}
                max={65535}
              />
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group form-group--full">
              <label>Passwort (optional)</label>
              <PasswordInput
                value={form.password}
                onChange={v => handleInputChange('password', v)}
                show={showEVCCPassword}
                toggleShow={() => setShowEVCCPassword(!showEVCCPassword)}
                placeholder="EVCC Admin-Passwort"
                label=""
              />
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group form-group--full">
              <label>API Token (optional, alternativ zu Passwort)</label>
              <PasswordInput
                value={form.api_token}
                onChange={v => handleInputChange('api_token', v)}
                show={showEVCCAPIToken}
                toggleShow={() => setShowEVCCAPIToken(!showEVCCAPIToken)}
                placeholder="EVCC API Token"
                label=""
              />
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group form-group--checkbox">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={form.use_tls}
                  onChange={e => handleInputChange('use_tls', e.target.checked)}
                />
                <span>HTTPS (TLS) verwenden</span>
              </label>
            </div>
          </div>
          
          <div className="form-actions">
            <button
              className="btn btn--primary"
              onClick={handleTestEVCC}
              disabled={testingEVCC || !form.host}
            >
              {testingEVCC ? <Loader2 size={16} className="spin" /> : <Wifi size={16} />} 
              {testingEVCC ? 'Teste...' : 'Verbindung testen'}
            </button>
          </div>
        </div>
      </section>

      {/* TeslaMateAPI Configuration */}
      <section className="settings-section">
        <h2 className="settings-section-title">
          <Shield size={20} /> TeslaMateAPI (External Charging)
        </h2>
        <div className="settings-form">
          <div className="form-row">
            <div className="form-group form-group--full">
              <label>Base URL <span className="required">*</span></label>
              <input
                type="text"
                value={form.base_url}
                onChange={e => handleInputChange('base_url', e.target.value)}
                placeholder="z.B. http://192.168.1.21:8080/api/v1"
                required
              />
            </div>
          </div>
          
          <div className="form-row">
            <div className="form-group form-group--full">
              <label>Bearer Token (optional)</label>
              <PasswordInput
                value={form.token}
                onChange={v => handleInputChange('token', v)}
                show={showTMToken}
                toggleShow={() => setShowTMToken(!showTMToken)}
                placeholder="TeslaMateAPI Bearer Token"
                label=""
              />
            </div>
          </div>
          
          <div className="form-actions">
            <button
              className="btn btn--primary"
              onClick={handleTestTM}
              disabled={testingTM || !form.base_url}
            >
              {testingTM ? <Loader2 size={16} className="spin" /> : <Wifi size={16} />}
              {testingTM ? 'Teste...' : 'Verbindung testen'}
            </button>
          </div>
        </div>
      </section>

      {/* Save Button */}
      <section className="settings-section">
        <div className="save-bar">
          <button
            className="btn btn--save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? <Loader2 size={18} className="spin" /> : <Save size={18} />}
            {saving ? 'Speichere...' : 'Konfiguration speichern'}
          </button>
          <p className="save-hint">
            Die Konfiguration wird in der Datenbank persistiert und ist nach Neustart wieder verfügbar.
          </p>
        </div>
      </section>
    </div>
  );
}