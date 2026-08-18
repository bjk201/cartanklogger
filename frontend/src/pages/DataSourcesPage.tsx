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

  // Form state - base URL fields only
  const [form, setForm] = useState({
    evcc_base_url: '',
    evcc_api_token: '',
    teslamate_base_url: '',
    teslamate_token: '',
  });

  // Password visibility
  const [showEVCCAPIToken, setShowEVCCAPIToken] = useState(false);
  const [showTMToken, setShowTMToken] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configResponse, statusResponse] = await Promise.all([
        api.getDataSourceConfig(),
        api.getDataSourceStatus().catch(() => null)
      ]);

      setConfig(configResponse);
      setForm({
        evcc_base_url: configResponse.evcc_base_url || '',
        evcc_api_token: '',  // Never load token from backend (security)
        teslamate_base_url: configResponse.teslamateapi_base_url || '',
        teslamate_token: '',
      });

      // Initialize test results from status endpoint
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

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const savePayload: DataSourceConfigWrite = {
        evcc_base_url: form.evcc_base_url.trim(),
        evcc_api_token: form.evcc_api_token || undefined,
        teslamateapi_base_url: form.teslamate_base_url.trim(),
        teslamateapi_token: form.teslamate_token || undefined,
      };
      
      const response = await api.saveDataSourceConfig(savePayload);

      setSuccess('Konfiguration gespeichert');
      // Refetch to get updated fields
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
        evcc_base_url: form.evcc_base_url.trim(),
        evcc_api_token: form.evcc_api_token || undefined,
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
        teslamateapi_base_url: form.teslamate_base_url.trim(),
        teslamateapi_token: form.teslamate_token || undefined,
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

  const getStatusBadge = (status: { configured?: boolean; reachable?: boolean; level?: string; status_code?: number; error?: string; data_error?: string; last_checked?: string } | undefined) => {
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

  const PasswordInput = ({ value, onChange, show, toggleShow, placeholder, label }: {
    value: string;
    onChange: (v: string) => void;
    show: boolean;
    toggleShow: () => void;
    placeholder: string;
    label: string;
  }) => (
    <div className="form-group">
      <label>{label}</label>
      <div className="password-input-wrapper">
        <input
          type={show ? 'text' : 'password'}
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
            <div className={`status-card__value ${isLive ? 'status-live' : 'status-warn'}`}>
              {isLive ? 'Live' : 'Demo'}
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
            <div className="form-group form-group--full">
              <label>EVCC Base URL <span className="required">*</span></label>
              <input
                type="text"
                value={form.evcc_base_url}
                onChange={e => setForm(prev => ({ ...prev, evcc_base_url: e.target.value }))}
                placeholder="http://192.168.1.15:7070"
                required
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group form-group--full">
              <label>API Token (optional)</label>
              <PasswordInput
                value={form.evcc_api_token || ''}
                onChange={v => setForm(prev => ({ ...prev, evcc_api_token: v }))}
                show={showEVCCAPIToken}
                toggleShow={() => setShowEVCCAPIToken(!showEVCCAPIToken)}
                placeholder="EVCC API Token"
                label=""
              />
            </div>
          </div>

          <div className="form-actions">
            <button
              className="btn btn--primary"
              onClick={handleTestEVCC}
              disabled={testingEVCC || !form.evcc_base_url.trim()}
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
              <label>TeslaMateAPI Base URL <span className="required">*</span></label>
              <input
                type="text"
                value={form.teslamate_base_url}
                onChange={e => setForm(prev => ({ ...prev, teslamate_base_url: e.target.value }))}
                placeholder="http://192.168.1.21:8080/api/v1/"
                required
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group form-group--full">
              <label>Bearer Token (optional)</label>
              <PasswordInput
                value={form.teslamate_token || ''}
                onChange={v => setForm(prev => ({ ...prev, teslamate_token: v }))}
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
              disabled={testingTM || !form.teslamate_base_url.trim()}
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