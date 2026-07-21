// CarTankLogger Dashboard - Main Application Script

// Theme management
function initTheme() {
    // Check for saved theme preference or default to light
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        updateThemeIcon(true);
    }
    
    // Setup theme toggle button
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const isDark = currentTheme !== 'dark';
    
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateThemeIcon(isDark);
}

function updateThemeIcon(isDark) {
    const themeIcon = document.getElementById('themeIcon');
    if (themeIcon) {
        themeIcon.className = isDark ? 'bi bi-sun-fill' : 'bi bi-moon-fill';
    }
}

// Tab management
function initTabs() {
    const tabLinks = document.querySelectorAll('.sidebar .nav-link[data-tab]');
    
    tabLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            
            // Update active state
            tabLinks.forEach(l => l.classList.remove('active'));
            this.classList.add('active');
            
            // Show target tab
            const tabId = this.getAttribute('data-tab');
            showTab(tabId);
        });
    });
}

function showTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-pane').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Show target tab
    const targetTab = document.getElementById('tab-' + tabName);
    if (targetTab) {
        targetTab.classList.add('active');
    }
}

// Loading indicators
function showLoading(tabName) {
    const indicator = document.getElementById(tabName + 'LoadingIndicator');
    if (indicator) {
        indicator.style.display = 'inline-block';
    }
}

function hideLoading(tabName) {
    const indicator = document.getElementById(tabName + 'LoadingIndicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    initTheme();
    initTabs();
    
    // Load initial data
    loadOverviewData();
});

// Load overview data (loading units)
async function loadOverviewData() {
    showLoading('loading');
    
    try {
        const response = await fetch('/api/sessions?limit=10');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        renderLoadingUnits(data.home || []);
    } catch (error) {
        console.error('Error loading overview data:', error);
        document.getElementById('loadingUnitsTable').innerHTML = 
            '<tr><td colspan="6" class="text-center py-4 text-danger">Fehler beim Laden der Daten</td></tr>';
    } finally {
        hideLoading('loading');
    }
}

// Render loading units table
function renderLoadingUnits(units) {
    const tbody = document.getElementById('loadingUnitsTable');
    
    if (!units || units.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Keine Ladeeinheiten gefunden</td></tr>';
        return;
    }
    
    tbody.innerHTML = units.map(unit => `
        <tr>
            <td class="sticky-column">${formatDateTime(unit.created)}</td>
            <td>${unit.charged_kwh ? unit.charged_kwh.toFixed(2) : '-'}</td>
            <td>${unit.duration_min || '-'}</td>
            <td>${unit.cost ? unit.cost.toFixed(2) : '-'}</td>
            <td>${unit.source || '-'}</td>
            <td><span class="badge bg-${unit.status === 'completed' ? 'success' : 'warning'}">${unit.status || 'unknown'}</span></td>
        </tr>
    `).join('');
}

// Format date/time
function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('de-DE') + ' ' + date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// Export functions for external use
window.CarTankLogger = {
    initTheme,
    toggleTheme,
    showTab,
    loadOverviewData
};