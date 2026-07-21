// Update main JS event listeners for timeline filtering
const initTimeline = () => {
    const btns = document.querySelectorAll('.btn-group-sm .btn');
    const rangeFromInput = document.getElementById('rangeFrom');
    const rangeToInput = document.getElementById('rangeTo');
    const btnRange = document.getElementById('btnRange');

    // Handle quick buttons
    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentDays = parseInt(btn.dataset.days);
            customFrom = null;
            customTo = null;
            updateRangeLabel();
            loadAll();
        });
    });

    // Handle custom range
    btnRange.addEventListener('click', () => {
        if (rangeFromInput.value && rangeToInput.value) {
            const from = new Date(rangeFromInput.value);
            const to = new Date(rangeToInput.value);
            if (from > to) {
                alert('Das Startdatum muss vor dem Enddatum liegen');
                return;
            }
            customFrom = rangeFromInput.value;
            customTo = rangeToInput.value;
            currentDays = 9999;
            btns.forEach(b => b.classList.remove('active'));
            updateRangeLabel();
            loadAll();
        }
    });

    // Auto-apply if dates selected
    rangeFromInput.addEventListener('change', () => {
        if (rangeFromInput.value && rangeToInput.value) {
            btnRange.click();
        }
    });
    rangeToInput.addEventListener('change', () => {
        if (rangeFromInput.value && rangeToInput.value) {
            btnRange.click();
        }
    });
};

const initAdminLink = () => {
    // Smooth navigation for admin sidebar link
    const adminLink = document.querySelector('.sidebar .nav-link[href="#tabAdmin"]');
    if (adminLink) {
        adminLink.addEventListener('click', (e) => {
            e.preventDefault();
            // Ensure tab switching
            const trigger = new bootstrap.Tab(adminLink);
            trigger.show();
        });
    }
};

const initStickySidebar = () => {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        // Add scrollspy behavior for smooth scrolling
        const navLinks = sidebar.querySelectorAll('.nav-link');
        navLinks.forEach(link => {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                // Get target section
                const targetId = this.getAttribute('href').substring(1);
                const targetSection = document.getElementById(targetId);
                if (targetSection) {
                    targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Update active state
                    navLinks.forEach(l => l.classList.remove('active'));
                    this.classList.add('active');
                }
            });
        });
    }
};

const initResponsiveAdjustments = () => {
    // Adjust for mobile devices
    if (window.innerWidth < 768) {
        // Stack sidebar on top
        const container = document.querySelector('.container-fluid.d-flex');
        if (container) {
            container.style.flexDirection = 'column';
        }
        // Make sidebar height full width
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.style.width = '100%';
            sidebar.style.marginBottom = '1rem';
        }
    } else {
        // Reset on desktop
        const container = document.querySelector('.container-fluid.d-flex');
        if (container) {
            container.style.flexDirection = 'row';
        }
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.style.width = '220px';
            sidebar.style.marginBottom = '';
        }
    }
};

// Initialize everything
initTimeline();
initAdminLink();
initStickySidebar();
initResponsiveAdjustments();

// Reinitialize on window resize
window.addEventListener('resize', () => {
    initResponsiveAdjustments();
});

// Initial load setup
loadAll();