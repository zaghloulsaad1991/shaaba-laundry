/*
 * Shaaba Laundry System v2 - Full Frontend Controller
 * Connects Customer PWA, Driver PWA, Branch Portal, and Secured Admin Dashboard
 */
let CATALOG = null;
let ME_DATA = null;       // Customer isolated session data
let DRIVER_DATA = null;   // Driver isolated session data
let BRANCH_DATA = null;   // Branch isolated session data
let ADMIN_DATA = null;    // Admin bootstrap data
let ADMIN_ORDERS = [];
let ADMIN_REPORTS = null;

let CART = {};
let USE_SUBSCRIPTION_KILOS = false;
let APPLIED_COUPON = null; // { code, discount }
let PAYMENT_MODE = 'online';

let customerMap = null;
let customerMarker = null;
let driverLiveMarker = null;
let deferredPwaPrompt = null;

// Tokens stored per role in localStorage
const TOKENS = {
  customer: localStorage.getItem('shaaba_tok_customer') || '',
  driver: localStorage.getItem('shaaba_tok_driver') || '',
  branch: localStorage.getItem('shaaba_tok_branch') || '',
  admin: localStorage.getItem('shaaba_tok_admin') || ''
};

let sseConnections = {};

function setToken(role, token) {
  TOKENS[role] = token || '';
  if (token) localStorage.setItem('shaaba_tok_' + role, token);
  else localStorage.removeItem('shaaba_tok_' + role);
  connectRoleSse(role);
}

async function api(path, { method = 'GET', body = null, role = null } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (role && TOKENS[role]) headers['Authorization'] = 'Bearer ' + TOKENS[role];
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `خطأ HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Audio Notification
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch (e) {}
}

function showToast(title, body, icon = 'fa-bell') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-notification';
  el.innerHTML = `
    <div style="display:flex; align-items:flex-start; gap:10px;">
      <i class="fa-solid ${icon}" style="color:#38bdf8; font-size:18px; margin-top:3px;"></i>
      <div>
        <strong style="display:block; font-size:14px; margin-bottom:2px;">${title}</strong>
        <span style="font-size:12px; color:#cbd5e1;">${body}</span>
      </div>
    </div>
  `;
  container.appendChild(el);
  playNotificationSound();
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 5500);
}

// =========================================================
// PWA INSTALL & WEB PUSH NOTIFICATIONS
// =========================================================
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
});

async function installPwaPrompt() {
  if (deferredPwaPrompt) {
    deferredPwaPrompt.prompt();
    await deferredPwaPrompt.userChoice;
    deferredPwaPrompt = null;
  } else {
    showToast(
      'تثبيت تطبيق مغاسل سحابة (PWA)',
      'من متصفح الجوال (Safari أو Chrome): اضغط على قائمة المشاركة ثم اختر "إضافة إلى الشاشة الرئيسية / Add to Home Screen" ليعمل كتطبيق كامل!',
      'fa-mobile-screen-button'
    );
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function enableWebPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('تنبيه', 'متصفحك الحالي لا يدعم إشعارات Web Push', 'fa-circle-info');
    return;
  }
  const activeRole = ['customer', 'driver', 'branch', 'admin'].find((r) => TOKENS[r]);
  if (!activeRole) {
    showToast('سجل دخولك أولاً', 'سجل دخولك كعميل أو مندوب أو إدارة لتفعيل الإشعارات الفورية على جهازك.', 'fa-user-lock');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showToast('تنبيه', 'يرجى السماح بالإشعارات في المتصفح', 'fa-bell-slash');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    if (!CATALOG?.pushPublicKey) {
      showToast('تم تفعيل التنبيهات الصوتية', 'الإشعارات اللحظية مفعلة الآن!', 'fa-bell');
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CATALOG.pushPublicKey)
    });
    await api('/api/push/subscribe', { method: 'POST', role: activeRole, body: { subscription: sub } });
    showToast('تم تفعيل إشعارات الجوال بنجاح ✅', 'ستصلك إشعارات الطلبات وتحديثات الغسيل حتى لو كان المتصفح بالخلفية.', 'fa-bell');
  } catch (e) {
    showToast('تم تفعيل الإشعارات داخل النظام', e.message || 'جاهز لاستقبال التنبيهات', 'fa-bell');
  }
}

// =========================================================
// VIEW SWITCHING & REALTIME SSE
// =========================================================
function switchSystemView(viewName) {
  document.querySelectorAll('.app-view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.switcher-btn').forEach((b) => b.classList.remove('active'));

  const targetView = document.getElementById(`view-${viewName}`);
  const targetBtn = document.getElementById(`tabBtn-${viewName}`);
  if (targetView) targetView.classList.add('active');
  if (targetBtn) targetBtn.classList.add('active');

  if (viewName === 'customer' && customerMap) {
    setTimeout(() => customerMap.invalidateSize(), 150);
  }
  if (viewName === 'driver') loadDriverMe();
  if (viewName === 'branch') loadBranchMe();
  if (viewName === 'admin') loadAdminBootstrap();
}

function selectServiceTab(tabKey) {
  document.querySelectorAll('.service-tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById(`srvTab-${tabKey}`)?.classList.add('active');
  document.getElementById(`panel-${tabKey}`)?.classList.add('active');
}

function connectRoleSse(role) {
  if (sseConnections[role]) {
    sseConnections[role].close();
    delete sseConnections[role];
  }
  const token = TOKENS[role];
  if (!token) return;

  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'notification' && msg.data) {
        showToast(msg.data.title, msg.data.body, 'fa-bell');
      }
      if (msg.type === 'driver_location' && msg.data) {
        updateLiveDriverPinOnCustomerMap(msg.data.lat, msg.data.lng);
      }
      if (role === 'customer') loadCustomerMe();
      if (role === 'driver') loadDriverMe();
      if (role === 'branch') loadBranchMe();
      if (role === 'admin') loadAdminOrdersOnly();
    } catch (e) {}
  };
  sseConnections[role] = es;
}

// =========================================================
// INITIAL LOAD & AUTO DEMO CUSTOMER LOGIN
// =========================================================
async function initApp() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  CATALOG = await api('/api/catalog');
  renderCatalog();

  // Check URL return from Payment Gateway
  const params = new URLSearchParams(location.search);
  if (params.get('pay') === 'paid') {
    showToast('تمت عملية الدفع الإلكتروني بنجاح ✅', 'تم تحديث طلبك / اشتراكك وإصدار الفاتورة الضريبية.', 'fa-circle-check');
    history.replaceState({}, '', location.pathname + location.hash);
  } else if (params.get('pay') === 'failed') {
    showToast('لم تكتمل عملية الدفع', 'تم إلغاء عملية الدفع، يمكنك المحاولة مجدداً.', 'fa-circle-xmark');
    history.replaceState({}, '', location.pathname + location.hash);
  }

  // If no customer token yet, auto-login Demo Customer 1 so the user sees a working customer profile immediately
  if (!TOKENS.customer && CATALOG.demoMode) {
    try {
      const otpRes = await api('/api/auth/otp/request', { method: 'POST', body: { phone: '0551234567' } });
      if (otpRes.demoCode) {
        const verRes = await api('/api/auth/otp/verify', {
          method: 'POST',
          body: { phone: '0551234567', code: otpRes.demoCode, name: 'أحمد محمد العتيبي' }
        });
        setToken('customer', verRes.token);
      }
    } catch (e) {}
  }

  if (TOKENS.customer) await loadCustomerMe();
  else renderCustomerGuestState();

  if (TOKENS.driver) connectRoleSse('driver');
  if (TOKENS.branch) connectRoleSse('branch');
  if (TOKENS.admin) connectRoleSse('admin');
}

async function loadCustomerMe() {
  try {
    ME_DATA = await api('/api/me', { role: 'customer' });
    renderCustomerAuthenticated();
  } catch (e) {
    setToken('customer', '');
    ME_DATA = null;
    renderCustomerGuestState();
  }
}

// =========================================================
// CUSTOMER AUTH MODAL (DYNAMIC OTP)
// =========================================================
function openCustomerLoginModal() {
  resetCustLoginStep1();
  document.getElementById('customerLoginModal').classList.add('open');
}
function closeCustomerLoginModal() {
  document.getElementById('customerLoginModal').classList.remove('open');
}
function resetCustLoginStep1() {
  document.getElementById('custLoginStep1').style.display = 'block';
  document.getElementById('custLoginStep2').style.display = 'none';
}
function fillDemoCustomer(name, phone) {
  document.getElementById('loginCustName').value = name;
  document.getElementById('loginCustPhone').value = phone;
}

async function requestCustomerOtp() {
  const phone = document.getElementById('loginCustPhone').value.trim();
  try {
    const res = await api('/api/auth/otp/request', { method: 'POST', body: { phone } });
    document.getElementById('custLoginStep1').style.display = 'none';
    document.getElementById('custLoginStep2').style.display = 'block';
    const hintBox = document.getElementById('otpDemoHintBox');
    if (res.demoCode) {
      hintBox.innerHTML = `رمز التحقق المولد لرقمك الآن هو: <strong style="font-size:16px;">${res.demoCode}</strong> (تمت تعبئته تلقائياً للتجربة)`;
      document.getElementById('loginCustOtp').value = res.demoCode;
    } else {
      hintBox.textContent = 'تم إرسال رسالة SMS برمز التحقق إلى جوالك.';
      document.getElementById('loginCustOtp').value = '';
    }
  } catch (e) {
    showToast('خطأ في رقم الجوال', e.message, 'fa-triangle-exclamation');
  }
}

async function verifyCustomerOtp() {
  const phone = document.getElementById('loginCustPhone').value.trim();
  const name = document.getElementById('loginCustName').value.trim();
  const code = document.getElementById('loginCustOtp').value.trim();
  const referralCode = document.getElementById('loginCustReferral').value.trim();
  const zoneId = document.getElementById('zoneSelect')?.value || '';

  try {
    const res = await api('/api/auth/otp/verify', {
      method: 'POST',
      body: { phone, name, code, referralCode, zoneId }
    });
    setToken('customer', res.token);
    closeCustomerLoginModal();
    showToast('مرحباً بك في مغاسل سحابة 👋', `تم تسجيل الدخول بحساب: ${res.customer.name}`, 'fa-user-check');
    await loadCustomerMe();
  } catch (e) {
    showToast('خطأ في التحقق', e.message, 'fa-circle-xmark');
  }
}

async function logoutCustomer() {
  try { await api('/api/auth/logout', { method: 'POST', role: 'customer' }); } catch (e) {}
  setToken('customer', '');
  ME_DATA = null;
  renderCustomerGuestState();
  showToast('تم تسجيل الخروج', 'تم الخروج من حساب العميل بنجاح', 'fa-right-from-bracket');
}

function renderCustomerGuestState() {
  document.getElementById('headerRemainingKilos').textContent = '0 كجم';
  document.getElementById('headerWalletSAR').textContent = '0 ر.س';
  document.getElementById('customerAccountArea').innerHTML = `
    <button class="btn btn-primary" style="padding:8px 16px; font-size:13px;" onclick="openCustomerLoginModal()">
      <i class="fa-solid fa-right-to-bracket"></i> تسجيل دخول العميل (OTP)
    </button>
  `;
  document.getElementById('walletActiveBadge').textContent = 'غير مسجل دخول';
  document.getElementById('walletPlanName').textContent = 'سجل دخولك برقم الجوال لعرض رصيد باقتك الشهرية وطلباتك الخاصة';
  document.getElementById('walletRemainingText').textContent = '0 كجم';
  document.getElementById('walletUsedText').textContent = '0 كجم';
  document.getElementById('walletProgressBar').style.width = '0%';
  document.getElementById('custReferralCode').textContent = '-';
  document.getElementById('customerOrdersList').innerHTML = `
    <div style="background:#fff; padding:24px; border-radius:16px; text-align:center; border:1px solid var(--border);">
      <p style="margin-bottom:12px; color:var(--text-muted);">سجل دخولك برقم جوالك لعرض طلباتك الخاصة وفواتيرك الضريبية</p>
      <button class="btn btn-primary" onclick="openCustomerLoginModal()">تسجيل دخول العميل</button>
    </div>
  `;
}

function renderCustomerAuthenticated() {
  if (!ME_DATA || !ME_DATA.customer) return;
  const c = ME_DATA.customer;

  document.getElementById('customerAccountArea').innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; background:#f8fafc; border:1px solid var(--border); padding:5px 10px; border-radius:12px;">
      <div style="font-size:12px;">
        <strong style="display:block;">${c.name}</strong>
        <span style="font-size:11px; color:var(--text-muted);">${c.phone}</span>
      </div>
      <button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" onclick="openCustomerLoginModal()">تبديل</button>
      <button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger); border-color:var(--danger);" onclick="logoutCustomer()">
        <i class="fa-solid fa-right-from-bracket"></i>
      </button>
    </div>
  `;

  document.getElementById('headerWalletSAR').textContent = `${c.walletBalance || 0} ر.س`;
  document.getElementById('sidebarWalletAmt').textContent = c.walletBalance || 0;
  document.getElementById('custReferralCode').textContent = c.referralCode || '-';

  const sub = c.subscription;
  const badge = document.getElementById('walletActiveBadge');
  const autoRenewEl = document.getElementById('autoRenewCheckbox');
  if (sub && sub.active) {
    const pct = Math.max(0, Math.min(100, Math.round((sub.remainingKilos / sub.totalKilos) * 100)));
    document.getElementById('headerRemainingKilos').textContent = `${sub.remainingKilos} كجم`;
    document.getElementById('walletPlanName').textContent = `${sub.planName} (ينتهي: ${new Date(sub.expiresAt).toLocaleDateString('ar-SA')})`;
    document.getElementById('walletRemainingText').textContent = `${sub.remainingKilos} كجم`;
    document.getElementById('walletUsedText').textContent = `${sub.usedKilos} من ${sub.totalKilos} كجم`;
    document.getElementById('walletProgressBar').style.width = `${pct}%`;
    badge.textContent = 'اشتراك نشط ✅';
    if (autoRenewEl) autoRenewEl.checked = !!sub.autoRenew;
  } else {
    document.getElementById('headerRemainingKilos').textContent = '0 كجم';
    document.getElementById('walletPlanName').textContent = 'لا يوجد اشتراك شهري نشط — اشترك الآن واستفد من التوصيل المجاني';
    document.getElementById('walletRemainingText').textContent = '0 كجم';
    document.getElementById('walletUsedText').textContent = '0 كجم';
    document.getElementById('walletProgressBar').style.width = '0%';
    badge.textContent = 'غير مشترك';
  }

  if (c.zoneId && document.getElementById('zoneSelect')) {
    document.getElementById('zoneSelect').value = c.zoneId;
    updateZoneBranchPreview();
  }
  if (c.address) {
    document.getElementById('customerAddressInput').value = c.address;
  }

  renderSubscriptions();
  renderCart();
  renderCustomerOrders();
}

async function toggleSubAutoRenew(enabled) {
  if (!TOKENS.customer) return openCustomerLoginModal();
  try {
    await api('/api/me/subscription/auto-renew', { method: 'POST', role: 'customer', body: { enabled } });
    showToast('تم تحديث التجديد التلقائي', enabled ? 'سيتم تذكيرك وتجديد باقتك تلقائياً مع ترحيل الكيلوهات المتبقية' : 'تم إيقاف التجديد التلقائي', 'fa-rotate');
  } catch (e) {
    showToast('تنبيه', e.message, 'fa-circle-info');
  }
}

function copyReferralCode() {
  const code = ME_DATA?.customer?.referralCode;
  if (!code) return openCustomerLoginModal();
  navigator.clipboard?.writeText(code);
  showToast('تم نسخ كود الدعوة 🎁', `شارك الكود (${code}) مع أصدقائك؛ صديقك يحصل على 15 ر.س وأنت تحصل على 20 ر.س في المحفظة!`, 'fa-copy');
}

// =========================================================
// CATALOG, MAP, COUPONS & CHECKOUT
// =========================================================
function renderCatalog() {
  if (!CATALOG) return;
  document.getElementById('activeGatewayLabel').textContent = CATALOG.payment.providerLabel;
  renderKiloPackages();
  renderSubscriptions();
  renderSpecialItems();
  renderZonesDropdown();
  renderCart();
}

function renderKiloPackages() {
  const container = document.getElementById('kiloPackagesContainer');
  if (!container || !CATALOG) return;
  container.innerHTML = CATALOG.kiloPackages.map((pkg) => {
    const qty = CART[pkg.id] ? CART[pkg.id].qty : 0;
    return `
      <div class="pkg-card ${pkg.popular ? 'popular' : ''}">
        <div>
          ${pkg.badge ? `<span class="card-badge">${pkg.badge}</span>` : ''}
          <div class="pkg-icon"><i class="fa-solid ${pkg.icon || 'fa-shirt'}"></i></div>
          <h3>${pkg.name}</h3>
          <p class="pkg-subtitle">${pkg.approxPieces || 'شامل الغسيل المنفرد والتوصيل'}</p>
          <ul class="perks-list">
            <li><i class="fa-solid fa-check-circle"></i> الوزن المشمول: <strong>${pkg.kilos} كيلو</strong></li>
            <li><i class="fa-solid fa-check-circle"></i> الخدمة: <strong>${pkg.serviceType}</strong></li>
            <li><i class="fa-solid fa-check-circle"></i> السعر شامل ضريبة القيمة المضافة 15%</li>
          </ul>
        </div>
        <div class="pkg-price-row">
          <div class="price-box">
            <span class="current-price">${pkg.price} <small style="font-size:12px;">ر.س</small></span>
            ${pkg.oldPrice ? `<span class="old-price">${pkg.oldPrice} ر.س</span>` : ''}
          </div>
          <div class="qty-control">
            <button class="qty-btn" onclick="updateCartItem('${pkg.id}', 'kilo_package', -1)">-</button>
            <span class="qty-val">${qty}</span>
            <button class="qty-btn" onclick="updateCartItem('${pkg.id}', 'kilo_package', 1)">+</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderSubscriptions() {
  const container = document.getElementById('subscriptionsContainer');
  if (!container || !CATALOG) return;
  const activePlanId = ME_DATA?.customer?.subscription?.active ? ME_DATA.customer.subscription.planId : null;

  container.innerHTML = CATALOG.subscriptions.map((sub) => {
    const isCurrent = activePlanId === sub.id;
    return `
      <div class="pkg-card ${sub.popular ? 'popular' : ''}">
        <div>
          <span class="card-badge">${sub.badge || 'باقة شهرية'}</span>
          <div class="pkg-icon" style="background:#fef3c7; color:#d97706;"><i class="fa-solid fa-crown"></i></div>
          <h3>${sub.name}</h3>
          <p class="pkg-subtitle">رصيد <strong>${sub.kilos} كيلو</strong> غسيل وكي طوال 30 يوماً</p>
          <ul class="perks-list">
            ${(sub.perks || []).map((p) => `<li><i class="fa-solid fa-circle-check"></i> ${p}</li>`).join('')}
            <li><i class="fa-solid fa-rotate"></i> ترحيل الكيلوهات المتبقية عند التجديد</li>
          </ul>
        </div>
        <div class="pkg-price-row">
          <div class="price-box">
            <span class="current-price">${sub.price} <small style="font-size:12px;">ر.س/شهر</small></span>
            ${sub.oldPrice ? `<span class="old-price">${sub.oldPrice} ر.س</span>` : ''}
          </div>
          <button class="btn ${isCurrent ? 'btn-success' : 'btn-primary'}" style="padding:9px 14px; font-size:12px;" onclick="startSubscriptionCheckout('${sub.id}')">
            <i class="fa-solid ${isCurrent ? 'fa-rotate' : 'fa-bolt'}"></i>
            ${isCurrent ? 'تجديد / زيادة الرصيد' : 'اشترك الآن'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderSpecialItems() {
  const container = document.getElementById('specialItemsContainer');
  if (!container || !CATALOG) return;
  container.innerHTML = CATALOG.specialItems.map((item) => {
    const qty = CART[item.id] ? CART[item.id].qty : 0;
    return `
      <div class="pkg-card">
        <div>
          <span class="card-badge">${item.category}</span>
          <div class="pkg-icon"><i class="fa-solid ${item.icon || 'fa-rug'}"></i></div>
          <h3>${item.name}</h3>
          <p class="pkg-subtitle">${item.description}</p>
        </div>
        <div class="pkg-price-row">
          <div class="price-box">
            <span class="current-price">${item.price} <small style="font-size:12px;">ر.س / ${item.unit}</small></span>
          </div>
          <div class="qty-control">
            <button class="qty-btn" onclick="updateCartItem('${item.id}', 'special', -1)">-</button>
            <span class="qty-val">${qty}</span>
            <button class="qty-btn" onclick="updateCartItem('${item.id}', 'special', 1)">+</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function updateCartItem(id, type, delta) {
  const list = type === 'kilo_package' ? CATALOG.kiloPackages : CATALOG.specialItems;
  const item = list.find((x) => x.id === id);
  if (!item) return;
  if (!CART[id]) CART[id] = { id: item.id, name: item.name, price: item.price, kilos: item.kilos || 0, type, qty: 0 };
  CART[id].qty += delta;
  if (CART[id].qty <= 0) delete CART[id];
  renderKiloPackages();
  renderSpecialItems();
  renderCart();
}

function useMonthlySubscriptionInCart() {
  if (!TOKENS.customer) return openCustomerLoginModal();
  if (!ME_DATA?.customer?.subscription?.active) {
    showToast('لا يوجد اشتراك نشط', 'اشترك في إحدى الباقات الشهرية أولاً لتتمكن من السحب من رصيد الكيلوهات.', 'fa-crown');
    selectServiceTab('subscriptions');
    return;
  }
  toggleSubscriptionMode(true);
}

function toggleSubscriptionMode(enabled) {
  USE_SUBSCRIPTION_KILOS = enabled;
  document.getElementById('subscriptionModeBanner').style.display = enabled ? 'block' : 'none';
  renderCart();
}

async function applyCouponCode() {
  if (!TOKENS.customer) return openCustomerLoginModal();
  const code = document.getElementById('couponCodeInput').value.trim();
  if (!code) return;
  const subtotal = Object.values(CART).reduce((s, i) => s + i.price * i.qty, 0);
  try {
    const res = await api('/api/coupons/validate', { method: 'POST', role: 'customer', body: { code, subtotal } });
    APPLIED_COUPON = res;
    showToast('تم تفعيل كود الخصم 🎉', `حصلت على خصم بقيمة ${res.discount} ر.س`, 'fa-tag');
    renderCart();
  } catch (e) {
    APPLIED_COUPON = null;
    showToast('كود الخصم غير صالح', e.message, 'fa-circle-xmark');
    renderCart();
  }
}

function renderCart() {
  const container = document.getElementById('cartItemsContainer');
  if (!container) return;

  const entries = Object.values(CART);
  let subtotal = 0;
  let html = '';

  if (USE_SUBSCRIPTION_KILOS) {
    const estKg = document.getElementById('estimatedSubKilosInput')?.value || 6;
    html += `
      <div class="cart-item-row" style="background:#f0fdf4; padding:8px; border-radius:8px;">
        <div>
          <strong style="color:#065f46;"><i class="fa-solid fa-crown"></i> سحب من رصيد الباقة الشهرية</strong>
          <div style="font-size:11px; color:#047857;">الوزن المتوقع ~${estKg} كجم (يُخصم الوزن الفعلي عند الاستلام)</div>
        </div>
        <strong style="color:#059669;">0 ر.س</strong>
      </div>
    `;
  }

  entries.forEach((e) => {
    const line = e.price * e.qty;
    subtotal += line;
    html += `
      <div class="cart-item-row">
        <div><strong>${e.name}</strong> <span style="color:var(--text-muted); font-size:12px;">× ${e.qty}</span></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <strong>${line} ر.س</strong>
          <button onclick="updateCartItem('${e.id}', '${e.type}', -${e.qty})" style="border:none; background:none; color:var(--danger); cursor:pointer;">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </div>
    `;
  });

  if (!html) {
    html = `<div style="text-align:center; padding:16px 8px; color:var(--text-muted); font-size:13px;">السلة فارغة — اختر باقة كيلو أو اطلب من رصيدك الشهري</div>`;
  }
  container.innerHTML = html;

  let discount = APPLIED_COUPON ? Math.min(subtotal, APPLIED_COUPON.discount) : 0;
  let afterDisc = Math.max(0, subtotal - discount);

  const useWallet = document.getElementById('useWalletCheckbox')?.checked;
  const walletAvail = ME_DATA?.customer?.walletBalance || 0;
  const walletUsed = useWallet ? Math.min(walletAvail, afterDisc) : 0;
  const netTotal = Math.round((afterDisc - walletUsed) * 100) / 100;
  const vatRate = CATALOG?.vatRate || 0.15;
  const vatVal = Math.round((netTotal - netTotal / (1 + vatRate)) * 100) / 100;

  document.getElementById('cartSubtotal').textContent = `${subtotal} ر.س`;
  document.getElementById('cartDiscountRow').style.display = discount > 0 ? 'flex' : 'none';
  if (discount > 0) {
    document.getElementById('cartCouponLabel').textContent = APPLIED_COUPON.code;
    document.getElementById('cartDiscountVal').textContent = `-${discount} ر.س`;
  }
  document.getElementById('cartWalletRow').style.display = walletUsed > 0 ? 'flex' : 'none';
  if (walletUsed > 0) document.getElementById('cartWalletVal').textContent = `-${walletUsed} ر.س`;

  document.getElementById('cartVatVal').textContent = `${vatVal} ر.س`;
  document.getElementById('cartTotal').textContent = `${netTotal} ر.س`;
}

function selectPaymentMode(mode, el) {
  PAYMENT_MODE = mode;
  document.querySelectorAll('#paymentMethodsGrid .pay-option').forEach((x) => x.classList.remove('selected'));
  if (el) el.classList.add('selected');
}

function renderZonesDropdown() {
  const select = document.getElementById('zoneSelect');
  if (!select || !CATALOG?.zones) return;
  const cur = select.value || CATALOG.zones[0]?.id;
  select.innerHTML = CATALOG.zones.map((z) => `
    <option value="${z.id}" ${z.id === cur ? 'selected' : ''}>${z.city} — ${z.name}</option>
  `).join('');
  updateZoneBranchPreview();
  initOrUpdateMap();
}

function updateZoneBranchPreview() {
  const select = document.getElementById('zoneSelect');
  const z = CATALOG?.zones?.find((x) => x.id === select?.value) || CATALOG?.zones?.[0];
  if (z) {
    document.getElementById('detectedBranchText').textContent = `${z.branchName} (${z.city} - ${z.name})`;
  }
}

function onZoneChange() {
  const select = document.getElementById('zoneSelect');
  const z = CATALOG?.zones?.find((x) => x.id === select.value);
  if (z) {
    document.getElementById('customerAddressInput').value = `${z.city}، ${z.name}، شارع رئيسي`;
    updateZoneBranchPreview();
    if (customerMap && customerMarker) {
      customerMap.setView([z.lat, z.lng], 13);
      customerMarker.setLatLng([z.lat, z.lng]);
    }
  }
}

function initOrUpdateMap() {
  const mapEl = document.getElementById('customerMap');
  if (!mapEl || typeof L === 'undefined' || !CATALOG?.zones?.length) return;
  if (!customerMap) {
    const z0 = CATALOG.zones[0];
    customerMap = L.map('customerMap').setView([z0.lat, z0.lng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(customerMap);
    customerMarker = L.marker([z0.lat, z0.lng]).addTo(customerMap).bindPopup('موقع استلام الملابس').openPopup();

    CATALOG.zones.forEach((z) => {
      const c = L.circle([z.lat, z.lng], { color: '#0284c7', fillColor: '#38bdf8', fillOpacity: 0.2, radius: 2200 }).addTo(customerMap);
      c.bindTooltip(`${z.city}: ${z.name} (${z.branchName})`);
      c.on('click', () => {
        document.getElementById('zoneSelect').value = z.id;
        onZoneChange();
      });
    });

    customerMap.on('click', (e) => {
      customerMarker.setLatLng([e.latlng.lat, e.latlng.lng]);
    });
  }
}

function updateLiveDriverPinOnCustomerMap(lat, lng) {
  if (!customerMap || typeof L === 'undefined') return;
  if (!driverLiveMarker) {
    driverLiveMarker = L.circleMarker([lat, lng], { radius: 9, color: '#10b981', fillColor: '#059669', fillOpacity: 0.9 }).addTo(customerMap);
    driverLiveMarker.bindPopup('🚚 الموقع الحي للمندوب الآن').openPopup();
  } else {
    driverLiveMarker.setLatLng([lat, lng]);
  }
}

// =========================================================
// SUBMIT ORDER & SUBSCRIPTION CHECKOUT
// =========================================================
async function startSubscriptionCheckout(planId) {
  if (!TOKENS.customer) return openCustomerLoginModal();
  try {
    const res = await api('/api/payments/start', {
      method: 'POST',
      role: 'customer',
      body: { purpose: 'subscription', planId }
    });
    if (res.redirectUrl) location.href = res.redirectUrl;
  } catch (e) {
    showToast('تعذر بدء الاشتراك', e.message, 'fa-circle-xmark');
  }
}

async function submitCustomerOrder() {
  if (!TOKENS.customer) return openCustomerLoginModal();
  const items = Object.values(CART).map((i) => ({ id: i.id, qty: i.qty }));
  if (!items.length && !USE_SUBSCRIPTION_KILOS) {
    showToast('السلة فارغة', 'اختر باقة كيلو أو اطلب من رصيد باقتك الشهرية أو أضف سجاد/بطانيات أولاً.', 'fa-basket-shopping');
    return;
  }

  const pos = customerMarker ? customerMarker.getLatLng() : null;
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      role: 'customer',
      body: {
        type: 'standard',
        zoneId: document.getElementById('zoneSelect').value,
        address: document.getElementById('customerAddressInput').value,
        pickupSlot: document.getElementById('pickupSlotSelect').value,
        lat: pos ? pos.lat : undefined,
        lng: pos ? pos.lng : undefined,
        items,
        useSubscription: USE_SUBSCRIPTION_KILOS,
        estimatedKilos: Number(document.getElementById('estimatedSubKilosInput')?.value) || 6,
        couponCode: APPLIED_COUPON ? APPLIED_COUPON.code : null,
        useWallet: document.getElementById('useWalletCheckbox')?.checked,
        paymentMethod: PAYMENT_MODE
      }
    });

    CART = {};
    USE_SUBSCRIPTION_KILOS = false;
    APPLIED_COUPON = null;
    document.getElementById('subscriptionModeBanner').style.display = 'none';
    document.getElementById('couponCodeInput').value = '';

    if (res.redirectUrl) {
      location.href = res.redirectUrl;
      return;
    }
    showToast('تم تأكيد طلبك بنجاح ✅', `رقم الطلب #${res.order.id} وتم إشعار مندوب الحي فوراً.`, 'fa-circle-check');
    await loadCustomerMe();
    document.getElementById('orders').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    showToast('تعذر إنشاء الطلب', e.message, 'fa-circle-xmark');
  }
}

// =========================================================
// QUICK PICKUP CONFIRMATION MODAL ("اطلب المندوب الآن")
// =========================================================
function openQuickPickupConfirmModal() {
  if (!TOKENS.customer || !ME_DATA?.customer) return openCustomerLoginModal();
  const c = ME_DATA.customer;
  document.getElementById('qpCustNameText').textContent = c.name;
  document.getElementById('qpCustPhoneText').textContent = c.phone;

  const mainZ = document.getElementById('zoneSelect').value;
  document.getElementById('qpZoneSelect').innerHTML = CATALOG.zones.map((z) => `
    <option value="${z.id}" ${z.id === mainZ ? 'selected' : ''}>${z.city} — ${z.name}</option>
  `).join('');
  document.getElementById('qpAddressInput').value = document.getElementById('customerAddressInput').value;
  syncQuickPickupZone();

  document.getElementById('quickPickupConfirmBody').style.display = 'block';
  document.getElementById('quickPickupReceiptBody').style.display = 'none';
  document.getElementById('quickPickupConfirmModal').classList.add('open');
}

function syncQuickPickupZone() {
  const zId = document.getElementById('qpZoneSelect').value;
  const z = CATALOG.zones.find((x) => x.id === zId) || CATALOG.zones[0];
  if (z) document.getElementById('qpBranchDriverText').textContent = `${z.branchName} (${z.city} - ${z.name})`;
}

function closeQuickPickupConfirmModal() {
  document.getElementById('quickPickupConfirmModal').classList.remove('open');
}

async function confirmAndSendQuickPickup() {
  const useSub = document.getElementById('qpAccountingMode').value === 'deduct_monthly_sub';
  try {
    const res = await api('/api/orders', {
      method: 'POST',
      role: 'customer',
      body: {
        type: 'quick_pickup',
        zoneId: document.getElementById('qpZoneSelect').value,
        address: document.getElementById('qpAddressInput').value,
        pickupSlot: document.getElementById('qpSlotSelect').value,
        notes: document.getElementById('qpNotesInput').value,
        items: [],
        useSubscription: useSub,
        estimatedKilos: 5,
        paymentMethod: 'cod'
      }
    });
    const o = res.order;
    document.getElementById('quickPickupConfirmBody').style.display = 'none';
    document.getElementById('quickPickupReceiptBody').style.display = 'block';
    document.getElementById('qpReceiptSubtitle').textContent = `تم توجيه الطلب إلى (${o.branchName}) وإشعار المندوب (${o.driverName || 'مندوب المنطقة'}).`;
    document.getElementById('qpReceiptDetailsBox').innerHTML = `
      <div><strong>رقم الطلب المؤكد:</strong> #${o.id}</div>
      <div><strong>العميل:</strong> ${o.customerName} (${o.customerPhone})</div>
      <div><strong>العنوان:</strong> ${o.address}</div>
      <div><strong>المندوب المخصص:</strong> ${o.driverName || 'قيد التوجيه'} (${o.driverPhone || '-'})</div>
      <div><strong>طريقة الحساب:</strong> ${useSub ? 'خصم الوزن الفعلي من الباقة الشهرية' : 'تحديد الوزن بالميزان عند الاستلام وإصدار فاتورة'}</div>
    `;
    await loadCustomerMe();
  } catch (e) {
    showToast('تنبيه', e.message, 'fa-triangle-exclamation');
  }
}

// =========================================================
// CUSTOMER ORDERS, LIVE TRACKING, ZATCA INVOICE & RATING
// =========================================================
function renderCustomerOrders() {
  const container = document.getElementById('customerOrdersList');
  if (!container) return;
  const orders = ME_DATA?.orders || [];
  if (!orders.length) {
    container.innerHTML = `<div style="background:#fff; padding:24px; border-radius:16px; text-align:center; color:var(--text-muted); border:1px solid var(--border);">لا توجد طلبات مسجلة في حسابك حتى الآن.</div>`;
    return;
  }

  const stages = [
    { key: 'pending_driver', label: 'بانتظار قبول المندوب', icon: 'fa-bell' },
    { key: 'driver_en_route', label: 'المندوب بالطريق', icon: 'fa-truck-fast' },
    { key: 'picked_up', label: 'تم الاستلام والوزن', icon: 'fa-scale-balanced' },
    { key: 'washing', label: 'الغسيل والكي بالفرع', icon: 'fa-soap' },
    { key: 'ready', label: 'جاهز للتوصيل', icon: 'fa-box' },
    { key: 'out_for_delivery', label: 'في الطريق إليك', icon: 'fa-route' },
    { key: 'delivered', label: 'تم التسليم', icon: 'fa-circle-check' }
  ];

  container.innerHTML = orders.map((o) => {
    const mapStatus = o.status === 'at_branch' ? 'washing' : o.status;
    const idx = stages.findIndex((s) => s.key === mapStatus);

    const stepper = stages.map((st, i) => {
      let cls = '';
      if (i < idx || o.status === 'delivered') cls = 'done';
      else if (i === idx) cls = 'current';
      return `<div class="step-item ${cls}"><div class="step-circle"><i class="fa-solid ${st.icon}"></i></div><div>${st.label}</div></div>`;
    }).join('');

    const itemsDesc = (o.items || []).map((i) => `${i.name} (×${i.qty})`).join(' + ') +
      (o.useSubscription ? ' [خصم من الباقة الشهرية]' : '') +
      (o.pricing?.kiloChargeLabel ? ` [${o.pricing.kiloChargeLabel}]` : '') || 'طلب استلام فوري (الوزن عند الاستلام)';

    return `
      <div class="order-track-card">
        <div class="order-track-header">
          <div>
            <span style="background:var(--primary-light); color:var(--primary-dark); font-weight:900; padding:4px 10px; border-radius:8px; font-size:13px;">#${o.id}</span>
            <span style="font-size:12px; color:var(--text-muted); margin-right:8px;"><i class="fa-regular fa-clock"></i> ${o.pickupSlot}</span>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <span style="font-size:12px; font-weight:800; color:var(--primary-dark);">
              <i class="fa-solid fa-user-shield"></i> المندوب: ${o.driverName || 'جاري التوجيه'} (${o.branchName})
            </span>
            <button class="btn btn-outline" style="padding:4px 10px; font-size:11px;" onclick="openZatcaInvoiceModal('${o.id}')">
              <i class="fa-solid fa-file-invoice"></i> الفاتورة الضريبية (QR)
            </button>
            ${['pending_driver', 'awaiting_payment', 'unassigned'].includes(o.status) ? `
              <button class="btn btn-outline" style="padding:4px 10px; font-size:11px; color:var(--danger); border-color:var(--danger);" onclick="cancelCustomerOrder('${o.id}')">إلغاء الطلب</button>
            ` : ''}
          </div>
        </div>

        <div style="font-size:13px; margin-bottom:10px;"><strong>الخدمات:</strong> ${itemsDesc}</div>

        ${o.status === 'cancelled'
          ? `<div style="background:#fee2e2; color:#b91c1c; padding:10px; border-radius:10px; font-weight:800; font-size:13px;">تم إلغاء هذا الطلب</div>`
          : `<div class="stepper-wrapper">${stepper}</div>`
        }

        ${o.actualKilos ? `
          <div style="background:#f0fdf4; border:1px solid #86efac; padding:10px 14px; border-radius:10px; margin-top:10px; font-size:13px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <span><i class="fa-solid fa-scale-balanced" style="color:#059669;"></i> <strong>الوزن الفعلي المعتمد بالميزان: ${o.actualKilos} كجم</strong></span>
            ${o.scalePhotoUrl ? `<a href="${o.scalePhotoUrl}" target="_blank" class="btn btn-outline" style="padding:4px 10px; font-size:11px;"><i class="fa-solid fa-camera"></i> عرض صورة الميزان</a>` : ''}
          </div>
        ` : ''}

        ${o.outstanding > 0 && o.status !== 'cancelled' ? `
          <div style="background:#fff7ed; border:2px solid #f97316; border-radius:12px; padding:12px; margin-top:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <div>
              <strong style="color:#c2410c; font-size:13px;">يوجد مبلغ مستحق للسداد: ${o.outstanding} ر.س (شامل الضريبة 15%)</strong>
              <div style="font-size:11px; color:#9a3412;">يمكنك سداده إلكترونياً الآن عبر (${CATALOG?.payment?.providerLabel || 'بوابة الدفع'}) أو عند التسليم</div>
            </div>
            <button class="btn btn-primary" style="padding:8px 14px; font-size:12px;" onclick="payOrderBalanceOnline('${o.id}')">
              <i class="fa-solid fa-credit-card"></i> ادفع ${o.outstanding} ر.س إلكترونياً
            </button>
          </div>
        ` : ''}

        ${o.status === 'delivered' && !o.rating ? `
          <div style="margin-top:12px; text-align:left;">
            <button class="btn btn-gold" style="padding:7px 14px; font-size:12px;" onclick="openRatingModal('${o.id}')">
              <i class="fa-solid fa-star"></i> قيّم جودة الغسيل والمندوب
            </button>
          </div>
        ` : ''}
        ${o.rating ? `
          <div style="margin-top:10px; font-size:12px; color:#b45309; background:#fffbeb; padding:8px 12px; border-radius:8px;">
            ⭐ تقييمك للخدمة: ${o.rating.service}/5 • المندوب: ${o.rating.driver}/5 — "${o.rating.comment || 'شكراً لكم'}"
          </div>
        ` : ''}

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; padding-top:10px; border-top:1px dashed var(--border); font-size:12px; color:var(--text-muted);">
          <span>آخر تحديث: ${o.history?.[o.history.length - 1]?.label || ''}</span>
          <strong style="font-size:14px; color:var(--text);">الإجمالي الشامل للضريبة: ${o.grandTotal} ر.س (منها ضريبة 15%: ${o.grandVat} ر.س)</strong>
        </div>
      </div>
    `;
  }).join('');
}

async function payOrderBalanceOnline(orderId) {
  try {
    const res = await api('/api/payments/start', { method: 'POST', role: 'customer', body: { purpose: 'balance', orderId } });
    if (res.redirectUrl) location.href = res.redirectUrl;
  } catch (e) {
    showToast('خطأ في الدفع', e.message, 'fa-circle-xmark');
  }
}

async function cancelCustomerOrder(orderId) {
  try {
    await api(`/api/orders/${orderId}/cancel`, { method: 'POST', role: 'customer' });
    showToast('تم إلغاء الطلب', 'تم إلغاء الطلب وإعادة أي رصيد محفظة مستخدم.', 'fa-check');
    await loadCustomerMe();
  } catch (e) {
    showToast('تعذر الإلغاء', e.message, 'fa-circle-xmark');
  }
}

function openZatcaInvoiceModal(orderId) {
  const allOrders = [...(ME_DATA?.orders || []), ...(ADMIN_ORDERS || [])];
  const o = allOrders.find((x) => x.id === orderId);
  if (!o) return;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(o.zatcaTlv || o.id)}`;
  const netBeforeVat = Math.round((o.grandTotal - o.grandVat) * 100) / 100;

  document.getElementById('invoicePrintableArea').innerHTML = `
    <div style="border:2px solid #0f172a; border-radius:16px; padding:18px; text-align:center;">
      <h3 style="font-size:19px; font-weight:900; color:#0f172a;">فاتورة ضريبية مبسطة</h3>
      <p style="font-size:13px; font-weight:700; color:#0369a1;">${CATALOG?.brandName || 'مغاسل سحابة'} — الدمام والخبر</p>
      <p style="font-size:12px; color:#64748b;">الرقم الضريبي (VAT): <strong>310123456700003</strong></p>
      <hr style="margin:10px 0; border:none; border-top:1px dashed #cbd5e1;" />
      <div style="text-align:right; font-size:12px; line-height:1.8;">
        <div><strong>رقم الفاتورة / الطلب:</strong> #${o.id}</div>
        <div><strong>تاريخ الإصدار:</strong> ${new Date(o.createdAt).toLocaleString('ar-SA')}</div>
        <div><strong>العميل:</strong> ${o.customerName} (${o.customerPhone})</div>
        <div><strong>الفرع:</strong> ${o.branchName}</div>
      </div>
      <hr style="margin:10px 0; border:none; border-top:1px dashed #cbd5e1;" />
      <div style="text-align:right; font-size:12px;">
        ${(o.items || []).map((i) => `<div style="display:flex; justify-content:space-between;"><span>${i.name} × ${i.qty}</span><strong>${i.price * i.qty} ر.س</strong></div>`).join('')}
        ${o.pricing?.extraCost > 0 ? `<div style="display:flex; justify-content:space-between;"><span>فرق وزن إضافي (${o.pricing.extraKilos} كجم)</span><strong>${o.pricing.extraCost} ر.س</strong></div>` : ''}
      </div>
      <hr style="margin:10px 0; border:none; border-top:1px dashed #cbd5e1;" />
      <div style="text-align:right; font-size:13px; line-height:1.8;">
        <div style="display:flex; justify-content:space-between;"><span>المبلغ قبل الضريبة:</span><span>${netBeforeVat} ر.س</span></div>
        <div style="display:flex; justify-content:space-between;"><span>ضريبة القيمة المضافة (15%):</span><span>${o.grandVat} ر.س</span></div>
        <div style="display:flex; justify-content:space-between; font-size:16px; font-weight:900; color:#0369a1;"><span>الإجمالي شامل الضريبة:</span><span>${o.grandTotal} ر.س</span></div>
      </div>
      <div style="margin-top:14px;">
        <img src="${qrUrl}" alt="ZATCA QR Code" style="width:135px; height:135px; border:1px solid #e2e8f0; padding:6px; border-radius:10px;" />
        <div style="font-size:10px; color:#64748b; margin-top:4px;">رمز استجابة متوافق مع هيئة الزكاة والضريبة والجمارك (ZATCA TLV)</div>
      </div>
    </div>
  `;
  document.getElementById('invoiceModal').classList.add('open');
}

function openRatingModal(orderId) {
  document.getElementById('rateOrderId').value = orderId;
  document.getElementById('rateCommentInput').value = '';
  document.getElementById('ratingModal').classList.add('open');
}

async function submitOrderRating() {
  const orderId = document.getElementById('rateOrderId').value;
  const service = Number(document.getElementById('rateServiceSelect').value);
  const driver = Number(document.getElementById('rateDriverSelect').value);
  const comment = document.getElementById('rateCommentInput').value;
  try {
    await api(`/api/orders/${orderId}/rate`, { method: 'POST', role: 'customer', body: { service, driver, comment } });
    document.getElementById('ratingModal').classList.remove('open');
    showToast('شكراً لتقييمك ⭐', 'تم حفظ تقييمك بنجاح لتحسين جودة الخدمة.', 'fa-star');
    await loadCustomerMe();
  } catch (e) {
    showToast('تنبيه', e.message, 'fa-circle-info');
  }
}

// =========================================================
// VIEW 2: DRIVER APP CONTROLLER
// =========================================================
async function quickDriverLogin(phone) {
  try {
    const res = await api('/api/auth/driver', { method: 'POST', body: { phone, pin: '1234' } });
    setToken('driver', res.token);
    showToast(`تم دخول الكابتن: ${res.driver.name}`, `المنطقة: ${res.driver.city}`, 'fa-truck-fast');
    await loadDriverMe();
  } catch (e) {
    showToast('خطأ في دخول المندوب', e.message, 'fa-circle-xmark');
  }
}

async function submitDriverLoginForm() {
  const phone = document.getElementById('drvPhoneInput').value.trim();
  const pin = document.getElementById('drvPinInput').value.trim();
  try {
    const res = await api('/api/auth/driver', { method: 'POST', body: { phone, pin } });
    setToken('driver', res.token);
    await loadDriverMe();
  } catch (e) {
    showToast('بيانات الدخول غير صحيحة', e.message, 'fa-circle-xmark');
  }
}

async function logoutDriver() {
  try { await api('/api/auth/logout', { method: 'POST', role: 'driver' }); } catch (e) {}
  setToken('driver', '');
  DRIVER_DATA = null;
  renderDriverPortal();
}

async function loadDriverMe() {
  if (!TOKENS.driver) {
    DRIVER_DATA = null;
    return renderDriverPortal();
  }
  try {
    DRIVER_DATA = await api('/api/driver/me', { role: 'driver' });
    renderDriverPortal();
  } catch (e) {
    setToken('driver', '');
    DRIVER_DATA = null;
    renderDriverPortal();
  }
}

function renderDriverPortal() {
  const body = document.getElementById('driverScreenBody');
  const headerName = document.getElementById('activeDriverHeaderName');
  const headerActions = document.getElementById('driverHeaderRightActions');
  if (!body) return;

  if (!DRIVER_DATA || !DRIVER_DATA.driver) {
    headerName.textContent = 'تسجيل دخول المندوب';
    headerActions.innerHTML = '';
    body.innerHTML = `
      <div style="background:#fff; border-radius:20px; padding:22px; margin-top:14px;">
        <h3 style="text-align:center; font-size:17px; font-weight:900; color:var(--primary-dark); margin-bottom:12px;">
          <i class="fa-solid fa-id-card-clip"></i> دخول مناديب مغاسل سحابة
        </h3>
        <div class="form-group">
          <label>رقم جوال المندوب (05xxxxxxxx):</label>
          <input type="tel" class="form-control" id="drvPhoneInput" value="0501112233" style="direction:ltr; text-align:right; font-weight:800;" />
        </div>
        <div class="form-group">
          <label>الرمز السري الخاص بالمندوب (PIN):</label>
          <input type="password" class="form-control" id="drvPinInput" value="1234" style="text-align:center; font-size:18px; font-weight:900; letter-spacing:6px;" />
        </div>
        <button class="btn btn-primary" style="width:100%; padding:12px;" onclick="submitDriverLoginForm()">
          <i class="fa-solid fa-right-to-bracket"></i> تسجيل الدخول وتفعيل الإشعارات
        </button>
      </div>
    `;
    return;
  }

  const d = DRIVER_DATA.driver;
  headerName.textContent = `${d.name} (${d.city})`;
  headerActions.innerHTML = `
    <div style="display:flex; gap:6px; align-items:center;">
      <button onclick="toggleDriverDuty(${!d.onDuty})" style="background:${d.onDuty ? '#10b981' : '#64748b'}; color:#fff; border:none; padding:4px 8px; border-radius:8px; font-size:11px; font-weight:800; cursor:pointer;">
        ${d.onDuty ? 'متاح ✅' : 'غير متاح ⏸️'}
      </button>
      <button onclick="logoutDriver()" style="background:rgba(239,68,68,0.25); color:#fecaca; border:none; padding:4px 8px; border-radius:8px; font-size:11px; cursor:pointer;">خروج</button>
    </div>
  `;

  const topTools = `
    <div style="background:#e0f2fe; border:1px solid #bae6fd; padding:10px; border-radius:12px; margin-bottom:10px; font-size:12px; display:flex; justify-content:space-between; align-items:center;">
      <span><i class="fa-solid fa-location-dot"></i> المنطقة: <strong>${d.zoneName}</strong></span>
      <button class="btn btn-primary" style="padding:5px 10px; font-size:11px;" onclick="broadcastDriverGps()">
        <i class="fa-solid fa-satellite-dish"></i> تحديث موقعي (GPS)
      </button>
    </div>
  `;

  const orders = DRIVER_DATA.orders || [];
  if (!orders.length) {
    body.innerHTML = topTools + `<div style="background:#fff; border-radius:16px; padding:32px 16px; text-align:center; color:var(--text-muted); font-size:13px;">لا توجد طلبات مسندة إليك حالياً في (${d.zoneName})</div>`;
    return;
  }

  body.innerHTML = topTools + orders.map((o) => {
    const itemsText = (o.items || []).map((i) => `${i.name} ×${i.qty}`).join('، ') +
      (o.useSubscription ? ' [خصم من الباقة الشهرية]' : '') || 'طلب استلام فوري (الوزن بالميزان عند الباب)';

    let controls = '';
    if (o.status === 'pending_driver') {
      const remSec = o.offerExpiresAt ? Math.max(0, Math.round((new Date(o.offerExpiresAt).getTime() - Date.now()) / 1000)) : 300;
      controls = `
        <div style="background:#fef3c7; color:#92400e; padding:6px 10px; border-radius:8px; font-size:11px; font-weight:800; margin:8px 0;">
          ⏳ مهلة القبول قبل التحويل التلقائي لمندوب آخر: ${Math.floor(remSec / 60)} د و ${remSec % 60} ث
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-success" style="flex:1; padding:10px; font-size:12px;" onclick="driverAcceptOrder('${o.id}')">
            <i class="fa-solid fa-check"></i> قبول والتوجه للعميل
          </button>
          <button class="btn btn-outline" style="padding:10px; font-size:12px; color:var(--danger); border-color:var(--danger);" onclick="driverRejectOrder('${o.id}')">
            اعتذار / تحويل
          </button>
        </div>
      `;
    } else if (o.status === 'driver_en_route') {
      const defKg = o.estimatedKilos || 6.5;
      controls = `
        <div class="scale-box">
          <strong style="font-size:12px; color:var(--primary-dark); display:block; margin-bottom:6px;">
            <i class="fa-solid fa-scale-balanced"></i> وزن الملابس وتصوير شاشة الميزان الرقمي:
          </strong>
          <div style="margin-bottom:8px;">
            <label style="font-size:11px; display:block; margin-bottom:3px;">صورة شاشة الميزان (كاميرا الجوال):</label>
            <input type="file" accept="image/*" capture="environment" id="scalePhoto-${o.id}" class="form-control" style="font-size:11px; padding:5px;" />
          </div>
          <div style="display:flex; gap:6px;">
            <input type="number" step="0.5" min="0.5" id="scaleKg-${o.id}" value="${defKg}" class="form-control" style="font-weight:900; font-size:15px;" />
            <button class="btn btn-success" style="white-space:nowrap; font-size:12px;" onclick="driverSubmitWeight('${o.id}')">
              تأكيد الوزن والاستلام
            </button>
          </div>
        </div>
      `;
    } else if (o.status === 'picked_up') {
      controls = `
        <button class="btn btn-primary" style="width:100%; margin-top:8px; font-size:12px;" onclick="driverHandoverBranch('${o.id}')">
          <i class="fa-solid fa-store"></i> تسليم الكيس إلى (${o.branchName}) للغسيل
        </button>
      `;
    } else if (o.status === 'at_branch' || o.status === 'washing') {
      controls = `
        <div style="background:#e0f2fe; color:#0369a1; padding:8px; border-radius:8px; font-size:12px; font-weight:700; margin-top:8px; text-align:center;">
          🧺 الملابس داخل (${o.branchName}) — بانتظار انتهاء الغسيل والكي من بوابة الفرع
        </div>
      `;
    } else if (o.status === 'ready') {
      controls = `
        <button class="btn btn-gold" style="width:100%; margin-top:8px; font-size:12px;" onclick="driverPickupReady('${o.id}')">
          <i class="fa-solid fa-truck-ramp-box"></i> استلام الملابس الجاهزة من الفرع والتوجه للعميل
        </button>
      `;
    } else if (o.status === 'out_for_delivery') {
      controls = `
        ${o.outstanding > 0 ? `<div style="background:#fee2e2; color:#b91c1c; padding:8px; border-radius:8px; font-size:12px; font-weight:800; margin-top:8px;">💰 مطلوب تحصيل ${o.outstanding} ر.س (شبكة مدى / نقداً) عند الباب</div>` : ''}
        <button class="btn btn-success" style="width:100%; margin-top:8px; font-size:12px;" onclick="driverDeliverOrder('${o.id}', ${o.outstanding > 0})">
          <i class="fa-solid fa-circle-check"></i> ${o.outstanding > 0 ? `تأكيد تحصيل ${o.outstanding} ر.س وتسليم الملابس` : 'تأكيد تسليم الملابس للعميل'}
        </button>
      `;
    } else {
      controls = `<div style="background:#d1fae5; color:#065f46; padding:6px; border-radius:8px; text-align:center; font-size:12px; font-weight:800; margin-top:8px;">✅ مكتمل</div>`;
    }

    return `
      <div class="driver-order-card" style="margin:0 0 12px 0;">
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:900; color:var(--primary-dark); margin-bottom:4px;">
          <span>#${o.id} • ${o.customerName}</span>
          <span>${o.grandTotal} ر.س</span>
        </div>
        <div style="font-size:12px; color:var(--text-muted); margin-bottom:6px;">
          <i class="fa-solid fa-location-dot" style="color:var(--danger)"></i> ${o.address}
        </div>
        <div style="font-size:12px; background:#f8fafc; padding:8px; border-radius:8px; border:1px solid var(--border); margin-bottom:8px;">
          ${itemsText}
          ${o.actualKilos ? `<div style="color:#059669; font-weight:800; margin-top:4px;">الوزن المسجل: ${o.actualKilos} كجم</div>` : ''}
        </div>
        <div style="display:flex; gap:6px;">
          <a href="https://www.google.com/maps?q=${o.lat},${o.lng}" target="_blank" class="btn btn-outline" style="flex:1; padding:6px; font-size:11px;">
            <i class="fa-solid fa-map-location-dot"></i> الخريطة
          </a>
          <a href="https://wa.me/966${o.customerPhone.slice(1)}" target="_blank" class="btn btn-outline" style="flex:1; padding:6px; font-size:11px; color:#059669; border-color:#10b981;">
            <i class="fa-brands fa-whatsapp"></i> واتساب العميل
          </a>
        </div>
        ${controls}
      </div>
    `;
  }).join('');
}

async function toggleDriverDuty(onDuty) {
  await api('/api/driver/duty', { method: 'POST', role: 'driver', body: { onDuty } });
  await loadDriverMe();
}

async function broadcastDriverGps() {
  const z = CATALOG?.zones?.[0] || { lat: 26.4207, lng: 50.0888 };
  const lat = z.lat + (Math.random() - 0.5) * 0.01;
  const lng = z.lng + (Math.random() - 0.5) * 0.01;
  await api('/api/driver/location', { method: 'POST', role: 'driver', body: { lat, lng } });
  showToast('تم بث موقعك الحي (GPS) 🛰️', 'ظهر موقع سيارتك الآن على خريطة العميل ولوحة الإدارة.', 'fa-location-crosshairs');
}

async function driverAcceptOrder(id) {
  await api(`/api/driver/orders/${id}/accept`, { method: 'POST', role: 'driver' });
  await loadDriverMe();
}

async function driverRejectOrder(id) {
  const reason = prompt('سبب الاعتذار عن الطلب (سيتم تحويله تلقائياً لمندوب احتياطي):', 'مشغول بطلب آخر في منطقة بعيدة');
  if (reason === null) return;
  await api(`/api/driver/orders/${id}/reject`, { method: 'POST', role: 'driver', body: { reason } });
  showToast('تم تحويل الطلب لمندوب بديل', 'قام النظام بإعادة توجيه الطلب تلقائياً لمندوب احتياطي.', 'fa-shuffle');
  await loadDriverMe();
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

async function driverSubmitWeight(id) {
  const actualKilos = Number(document.getElementById(`scaleKg-${id}`).value);
  const fileInput = document.getElementById(`scalePhoto-${id}`);
  let photo = null;
  if (fileInput && fileInput.files && fileInput.files[0]) {
    photo = await fileToDataUrl(fileInput.files[0]);
  }
  try {
    const res = await api(`/api/driver/orders/${id}/weigh`, { method: 'POST', role: 'driver', body: { actualKilos, photo } });
    showToast('تم اعتماد الوزن بالميزان ⚖️', res.message, 'fa-scale-balanced');
    await loadDriverMe();
  } catch (e) {
    showToast('تنبيه الميزان', e.message, 'fa-triangle-exclamation');
  }
}

async function driverHandoverBranch(id) {
  await api(`/api/driver/orders/${id}/handover`, { method: 'POST', role: 'driver' });
  showToast('تم التسليم للفرع', 'وصل الطلب الآن إلى شاشة موظف الفرع لبدء الغسيل والكي.', 'fa-store');
  await loadDriverMe();
}

async function driverPickupReady(id) {
  await api(`/api/driver/orders/${id}/pickup-ready`, { method: 'POST', role: 'driver' });
  await loadDriverMe();
}

async function driverDeliverOrder(id, collected) {
  await api(`/api/driver/orders/${id}/deliver`, { method: 'POST', role: 'driver', body: { collected } });
  showToast('تم تسليم الطلب بنجاح ✅', 'تم إغلاق الطلب وإرسال طلب التقييم للعميل.', 'fa-circle-check');
  await loadDriverMe();
}

// =========================================================
// VIEW 3: BRANCH PORTAL CONTROLLER
// =========================================================
async function quickBranchLogin(username) {
  try {
    const res = await api('/api/auth/branch', { method: 'POST', body: { username, password: '123456' } });
    setToken('branch', res.token);
    showToast(`تم دخول الفرع: ${res.branch.name}`, `المدينة: ${res.branch.city}`, 'fa-store');
    await loadBranchMe();
  } catch (e) {
    showToast('خطأ دخول الفرع', e.message, 'fa-circle-xmark');
  }
}

async function loadBranchMe() {
  const container = document.getElementById('branchPortalBody');
  const actions = document.getElementById('branchHeaderActions');
  if (!container) return;

  if (!TOKENS.branch) {
    actions.innerHTML = '';
    container.innerHTML = `
      <div style="max-width:420px; margin:20px auto; background:#f8fafc; padding:22px; border-radius:16px; border:1px solid var(--border);">
        <h3 style="margin-bottom:12px; font-size:17px;">تسجيل دخول موظف الفرع</h3>
        <div class="form-group">
          <label>اسم مستخدم الفرع:</label>
          <input type="text" class="form-control" id="brUserInput" value="atheer" />
        </div>
        <div class="form-group">
          <label>كلمة المرور:</label>
          <input type="password" class="form-control" id="brPassInput" value="123456" />
        </div>
        <button class="btn btn-primary" style="width:100%;" onclick="quickBranchLogin(document.getElementById('brUserInput').value)">دخول الفرع</button>
      </div>
    `;
    return;
  }

  try {
    BRANCH_DATA = await api('/api/branch/me', { role: 'branch' });
    const b = BRANCH_DATA.branch;
    actions.innerHTML = `
      <span style="font-weight:800; color:var(--primary-dark); margin-left:10px;">${b.name} (${b.city})</span>
      <button class="btn btn-outline" style="padding:6px 12px; font-size:12px; color:var(--danger); border-color:var(--danger);" onclick="setToken('branch',''); loadBranchMe();">تسجيل خروج</button>
    `;

    const orders = BRANCH_DATA.orders || [];
    if (!orders.length) {
      container.innerHTML = `<div style="padding:30px; text-align:center; color:var(--text-muted);">لا توجد طلبات داخل (${b.name}) حالياً.</div>`;
      return;
    }

    container.innerHTML = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>رقم الطلب</th>
            <th>العميل</th>
            <th>المندوب</th>
            <th>الوزن الفعلي</th>
            <th>تفاصيل الملابس</th>
            <th>الحالة الحالية بالفرع</th>
            <th>الإجراء التالي</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map((o) => {
            let nextBtn = '-';
            if (o.status === 'picked_up') {
              nextBtn = `<button class="btn btn-primary" style="padding:6px 12px; font-size:12px;" onclick="updateBranchOrderStatus('${o.id}','at_branch')">تأكيد استلام الكيس بالفرع</button>`;
            } else if (o.status === 'at_branch') {
              nextBtn = `<button class="btn btn-primary" style="padding:6px 12px; font-size:12px;" onclick="updateBranchOrderStatus('${o.id}','washing')"><i class="fa-solid fa-soap"></i> بدء الغسيل المنفرد والكي</button>`;
            } else if (o.status === 'washing') {
              nextBtn = `<button class="btn btn-success" style="padding:6px 12px; font-size:12px;" onclick="updateBranchOrderStatus('${o.id}','ready')"><i class="fa-solid fa-check-double"></i> جاهز ومغلف (إشعار المندوب)</button>`;
            } else {
              nextBtn = `<span style="color:var(--success); font-weight:800;">جاهز / مع المندوب</span>`;
            }
            return `
              <tr>
                <td><strong>#${o.id}</strong></td>
                <td>${o.customerName}<br/><small>${o.customerPhone}</small></td>
                <td>${o.driverName}</td>
                <td><strong>${o.actualKilos || o.estimatedKilos} كجم</strong></td>
                <td>${(o.items || []).map((i) => `${i.name} ×${i.qty}`).join('، ') || 'غسيل بالكيلو'}</td>
                <td>${o.status}</td>
                <td>${nextBtn}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    setToken('branch', '');
    loadBranchMe();
  }
}

async function updateBranchOrderStatus(orderId, status) {
  await api(`/api/branch/orders/${orderId}/status`, { method: 'POST', role: 'branch', body: { status } });
  showToast('تم تحديث مرحلة الغسيل بالفرع 🧺', 'تم إرسال إشعار فوري للعميل والمندوب.', 'fa-soap');
  await loadBranchMe();
}

// =========================================================
// VIEW 4: SECURED ADMIN DASHBOARD & PAYMENT INTEGRATIONS
// =========================================================
async function submitAdminLogin() {
  const username = document.getElementById('admUserInput').value.trim();
  const password = document.getElementById('admPassInput').value.trim();
  try {
    const res = await api('/api/auth/admin', { method: 'POST', body: { username, password } });
    setToken('admin', res.token);
    showToast('مرحباً بك في لوحة الإدارة الشاملة 🛡️', 'تم الدخول بصلاحيات المدير العام', 'fa-shield-halved');
    await loadAdminBootstrap();
  } catch (e) {
    showToast('خطأ في الدخول', e.message, 'fa-circle-xmark');
  }
}

async function loadAdminOrdersOnly() {
  if (!TOKENS.admin) return;
  try {
    const ordRes = await api('/api/admin/orders', { role: 'admin' });
    ADMIN_ORDERS = ordRes.orders || [];
    renderAdminPortal();
  } catch (e) {}
}

async function loadAdminBootstrap() {
  const container = document.getElementById('adminPortalBody');
  if (!container) return;

  if (!TOKENS.admin) {
    container.innerHTML = `
      <div class="admin-panel-card" style="max-width:440px; margin:30px auto;">
        <h2 style="font-size:20px; font-weight:900; color:var(--primary-dark); margin-bottom:8px;">
          <i class="fa-solid fa-lock"></i> بوابة دخول الإدارة العامة | مغاسل سحابة
        </h2>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:16px;">
          لوحة الإدارة محمية بكلمة مرور لمنع أي تعديل غير مصرح به (بيانات الدخول الافتراضية للتجربة معبأة أدناه):
        </p>
        <div class="form-group">
          <label>اسم المستخدم:</label>
          <input type="text" class="form-control" id="admUserInput" value="admin" />
        </div>
        <div class="form-group">
          <label>كلمة المرور:</label>
          <input type="password" class="form-control" id="admPassInput" value="shaaba2026" />
        </div>
        <button class="btn btn-primary" style="width:100%; padding:12px;" onclick="submitAdminLogin()">
          <i class="fa-solid fa-right-to-bracket"></i> دخول لوحة الإدارة والتحكم
        </button>
      </div>
    `;
    return;
  }

  try {
    ADMIN_DATA = await api('/api/admin/bootstrap', { role: 'admin' });
    const ordRes = await api('/api/admin/orders', { role: 'admin' });
    ADMIN_ORDERS = ordRes.orders || [];
    ADMIN_REPORTS = await api('/api/admin/reports?range=30d', { role: 'admin' });
    renderAdminPortal();
  } catch (e) {
    setToken('admin', '');
    loadAdminBootstrap();
  }
}

function renderAdminPortal() {
  const container = document.getElementById('adminPortalBody');
  if (!container || !ADMIN_DATA) return;

  const rep = ADMIN_REPORTS?.totals || {};
  const pay = ADMIN_DATA.payment;
  const s = ADMIN_DATA.settings;
  const wa = ADMIN_DATA.notifications.whatsapp;

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:20px;">
      <div>
        <h2 style="font-size:24px; font-weight:900; color:var(--primary-dark);">لوحة الإدارة الشاملة والربط البرمجي (مغاسل سحابة)</h2>
        <p style="font-size:13px; color:var(--text-muted);">إدارة بوابات الدفع (Moyasar / Tap / PayTabs)، الضريبة 15%، الـ 20 فرعاً، المناديب، الباقات، والتقارير</p>
      </div>
      <button class="btn btn-outline" style="color:var(--danger); border-color:var(--danger);" onclick="setToken('admin',''); loadAdminBootstrap();">
        <i class="fa-solid fa-right-from-bracket"></i> تسجيل خروج الإدارة
      </button>
    </div>

    <!-- KPI Summary -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">إجمالي المبيعات (آخر 30 يوماً)</div>
        <div class="kpi-value">${rep.revenue || 0} ر.س</div>
        <small style="font-size:11px; color:var(--text-muted);">منها ضريبة 15%: ${rep.vat || 0} ر.س</small>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">إجمالي الطلبات / المسلمة</div>
        <div class="kpi-value">${rep.orders || 0} / <span style="color:var(--success)">${rep.delivered || 0}</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">الاشتراكات الشهرية النشطة</div>
        <div class="kpi-value">${ADMIN_REPORTS?.subscriptions?.active || 0} مشترك</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">بوابة الدفع الفعالة حالياً</div>
        <div class="kpi-value" style="font-size:17px; color:var(--success);">${pay.labels[pay.activeProvider]}</div>
      </div>
    </div>

    <!-- 1. PAYMENT GATEWAY INTEGRATION SETTINGS (MOYASAR / TAP / PAYTABS / SANDBOX) -->
    <div class="admin-panel-card" style="border:2px solid #0284c7;">
      <h3 style="font-size:18px; font-weight:900; color:var(--primary-dark); margin-bottom:6px;">
        <i class="fa-solid fa-credit-card"></i> 1. إعدادات الربط مع بوابات الدفع الإلكتروني (Moyasar / Tap / PayTabs)
      </h3>
      <p style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">
        اختر البوابة التي ترغب بتفعيلها للمتجر وتطبيق الجوال، وأدخل مفاتيح الربط (API Keys) من حسابك في ميسر أو تاب أو بيتابس، أو اتركها على <strong>الوضع التجريبي (Sandbox)</strong> للتجربة:
      </p>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:16px;">
        <div class="form-group">
          <label>بوابة الدفع المعتمدة حالياً:</label>
          <select class="form-control" id="admActiveGateway" style="font-weight:800;">
            <option value="sandbox" ${pay.activeProvider === 'sandbox' ? 'selected' : ''}>🧪 الوضع التجريبي (Sandbox - بدون تحصيل فعلي)</option>
            <option value="moyasar" ${pay.activeProvider === 'moyasar' ? 'selected' : ''}>🇸🇦 ميسر Moyasar (مدى / Apple Pay / فيزا)</option>
            <option value="tap" ${pay.activeProvider === 'tap' ? 'selected' : ''}>🇸🇦 تاب Tap Payments (مدى / Apple Pay / فيزا)</option>
            <option value="paytabs" ${pay.activeProvider === 'paytabs' ? 'selected' : ''}>🇸🇦 بيتابس PayTabs السعودية</option>
          </select>
        </div>
        <div class="form-group">
          <label>الدفع عند الاستلام (شبكة مدى مع المندوب):</label>
          <select class="form-control" id="admCodEnabled">
            <option value="true" ${pay.codEnabled ? 'selected' : ''}>مفعل ✅</option>
            <option value="false" ${!pay.codEnabled ? 'selected' : ''}>غير مفعل ❌</option>
          </select>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(290px, 1fr)); gap:16px; margin-bottom:16px;">
        <!-- Moyasar Box -->
        <div style="background:#f8fafc; padding:14px; border-radius:12px; border:1px solid var(--border);">
          <strong style="display:block; margin-bottom:8px; color:#0369a1;">🔹 بيانات الربط مع ميسر (Moyasar):</strong>
          <div class="form-group">
            <label>Publishable Key (pk_live_... أو pk_test_...):</label>
            <input type="text" class="form-control" id="moyPubKey" value="${pay.providers.moyasar.publishableKey || ''}" placeholder="pk_live_..." />
          </div>
          <div class="form-group">
            <label>Secret Key (sk_live_... أو sk_test_...):</label>
            <input type="password" class="form-control" id="moySecKey" value="${pay.providers.moyasar.secretKeyMasked || ''}" placeholder="sk_live_..." />
          </div>
          <button class="btn btn-outline" style="width:100%; padding:7px; font-size:12px;" onclick="testGatewayConnection('moyasar')">اختبار اتصال ميسر (Moyasar)</button>
        </div>

        <!-- Tap Payments Box -->
        <div style="background:#f8fafc; padding:14px; border-radius:12px; border:1px solid var(--border);">
          <strong style="display:block; margin-bottom:8px; color:#0369a1;">🔹 بيانات الربط مع تاب (Tap Payments):</strong>
          <div class="form-group">
            <label>Public Key (pk_live_...):</label>
            <input type="text" class="form-control" id="tapPubKey" value="${pay.providers.tap.publicKey || ''}" placeholder="pk_live_..." />
          </div>
          <div class="form-group">
            <label>Secret Key (sk_live_...):</label>
            <input type="password" class="form-control" id="tapSecKey" value="${pay.providers.tap.secretKeyMasked || ''}" placeholder="sk_live_..." />
          </div>
          <button class="btn btn-outline" style="width:100%; padding:7px; font-size:12px;" onclick="testGatewayConnection('tap')">اختبار اتصال تاب (Tap)</button>
        </div>

        <!-- PayTabs Box -->
        <div style="background:#f8fafc; padding:14px; border-radius:12px; border:1px solid var(--border);">
          <strong style="display:block; margin-bottom:8px; color:#0369a1;">🔹 بيانات الربط مع بيتابس (PayTabs):</strong>
          <div class="form-group">
            <label>Profile ID:</label>
            <input type="text" class="form-control" id="ptProfileId" value="${pay.providers.paytabs.profileId || ''}" placeholder="مثال: 98432" />
          </div>
          <div class="form-group">
            <label>Server Key:</label>
            <input type="password" class="form-control" id="ptServerKey" value="${pay.providers.paytabs.serverKeyMasked || ''}" placeholder="SZJN..." />
          </div>
          <button class="btn btn-outline" style="width:100%; padding:7px; font-size:12px;" onclick="testGatewayConnection('paytabs')">اختبار اتصال بيتابس (PayTabs)</button>
        </div>
      </div>

      <button class="btn btn-success" style="padding:12px 24px;" onclick="saveAdminPaymentSettings()">
        <i class="fa-solid fa-floppy-disk"></i> حفظ إعدادات بوابات الدفع وتفعيلها فوراً
      </button>
    </div>

    <!-- 2. ZATCA VAT & WHATSAPP CLOUD API SETTINGS -->
    <div class="admin-panel-card">
      <h3 style="font-size:17px; font-weight:800; color:var(--primary-dark); margin-bottom:12px;">
        <i class="fa-solid fa-file-invoice-dollar"></i> 2. إعدادات الضريبة والفوترة الإلكترونية (ZATCA) وإشعارات واتساب (WhatsApp API)
      </h3>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:14px;">
        <div class="form-group">
          <label>الرقم الضريبي للمنشأة (15 رقماً - يظهر في QR الفاتورة):</label>
          <input type="text" class="form-control" id="admVatNumber" value="${s.vatNumber || '310123456700003'}" />
        </div>
        <div class="form-group">
          <label>نسبة ضريبة القيمة المضافة (0.15 = 15%):</label>
          <input type="number" step="0.01" class="form-control" id="admVatRate" value="${s.vatRate}" />
        </div>
        <div class="form-group">
          <label>سعر الكيلو الإضافي (ر.س):</label>
          <input type="number" class="form-control" id="admExtraKiloPrice" value="${s.extraKiloPrice}" />
        </div>
        <div class="form-group">
          <label>مهلة قبول المندوب قبل التحويل التلقائي (ثانية):</label>
          <input type="number" class="form-control" id="admOfferTimeout" value="${s.dispatch.offerTimeoutSec}" />
        </div>
      </div>

      <div style="background:#f0fdf4; border:1px solid #bbf7d0; padding:12px; border-radius:12px; margin-bottom:14px;">
        <strong style="font-size:13px; color:#065f46; display:block; margin-bottom:8px;"><i class="fa-brands fa-whatsapp"></i> الربط المباشر مع WhatsApp Cloud API (لإرسال رسائل حالة الطلب للعميل):</strong>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px;">
          <div>
            <label style="font-size:11px;">حالة التفعيل:</label>
            <select class="form-control" id="waEnabled">
              <option value="false" ${!wa.enabled ? 'selected' : ''}>معطل (تسجيل في سجل الرسائل فقط)</option>
              <option value="true" ${wa.enabled ? 'selected' : ''}>مفعل (إرسال حي عبر Meta API)</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;">Phone Number ID:</label>
            <input type="text" class="form-control" id="waPhoneId" value="${wa.phoneNumberId || ''}" placeholder="من لوحة Meta Developers" />
          </div>
          <div>
            <label style="font-size:11px;">Access Token:</label>
            <input type="password" class="form-control" id="waToken" value="${wa.accessTokenMasked || ''}" placeholder="EAAG..." />
          </div>
        </div>
      </div>

      <button class="btn btn-primary" onclick="saveAdminGeneralAndWaSettings()">حفظ إعدادات الضريبة والواتساب والتشغيل</button>
    </div>

    <!-- 3. LIVE ORDERS & MANUAL DISPATCH -->
    <div class="admin-panel-card">
      <h3 style="font-size:17px; font-weight:800; color:var(--primary-dark); margin-bottom:12px;">
        <i class="fa-solid fa-boxes-packing"></i> 3. متابعة الطلبات وتوجيه المناديب اليدوي (${ADMIN_ORDERS.length} طلب)
      </h3>
      <div style="overflow-x:auto;">
        <table class="admin-table">
          <thead>
            <tr>
              <th>رقم الطلب</th>
              <th>العميل</th>
              <th>المنطقة والفرع</th>
              <th>المندوب الحالي</th>
              <th>الحالة</th>
              <th>الإجمالي (شامل الضريبة)</th>
              <th>تحويل لمندوب آخر / فاتورة</th>
            </tr>
          </thead>
          <tbody>
            ${ADMIN_ORDERS.map((o) => `
              <tr>
                <td><strong>#${o.id}</strong></td>
                <td>${o.customerName}<br/><small>${o.customerPhone}</small></td>
                <td>${o.city} - ${o.zoneName}<br/><small>${o.branchName}</small></td>
                <td>${o.driverName || '<span style="color:var(--danger)">بدون مندوب</span>'}</td>
                <td><strong>${o.status}</strong></td>
                <td>${o.grandTotal} ر.س</td>
                <td>
                  <div style="display:flex; gap:6px; align-items:center;">
                    <select class="form-control" style="width:140px; padding:4px; font-size:11px;" id="reassignDrv-${o.id}">
                      ${ADMIN_DATA.drivers.map((d) => `<option value="${d.id}" ${d.id === o.driverId ? 'selected' : ''}>${d.name} (${d.city})</option>`).join('')}
                    </select>
                    <button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" onclick="adminReassignOrder('${o.id}')">تحويل</button>
                    <button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" onclick="openZatcaInvoiceModal('${o.id}')">فاتورة</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 4. CATALOG PRICES MANAGEMENT -->
    <div class="admin-panel-card">
      <h3 style="font-size:17px; font-weight:800; color:var(--primary-dark); margin-bottom:12px;">
        <i class="fa-solid fa-tags"></i> 4. تعديل أسعار الباقات والاشتراكات الشهرية والسجاد
      </h3>
      <div style="overflow-x:auto;">
        <table class="admin-table">
          <thead>
            <tr>
              <th>القسم</th>
              <th>الاسم</th>
              <th>السعر الحالي (ر.س)</th>
              <th>حفظ</th>
            </tr>
          </thead>
          <tbody>
            ${[
              ...ADMIN_DATA.kiloPackages.map((x) => ({ col: 'kiloPackages', label: 'باقة كيلو', ...x })),
              ...ADMIN_DATA.subscriptions.map((x) => ({ col: 'subscriptions', label: 'اشتراك شهري', ...x })),
              ...ADMIN_DATA.specialItems.map((x) => ({ col: 'specialItems', label: 'قطعة خاصة/سجاد', ...x }))
            ].map((item) => `
              <tr>
                <td>${item.label}</td>
                <td><strong>${item.name}</strong></td>
                <td><input type="number" class="form-control" style="width:100px; font-weight:800;" id="admCatPrice-${item.id}" value="${item.price}" /></td>
                <td><button class="btn btn-success" style="padding:5px 12px; font-size:12px;" onclick="adminSaveCatalogPrice('${item.col}','${item.id}')">حفظ السعر</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function saveAdminPaymentSettings() {
  const activeProvider = document.getElementById('admActiveGateway').value;
  const codEnabled = document.getElementById('admCodEnabled').value === 'true';
  try {
    await api('/api/admin/payment', {
      method: 'PUT',
      role: 'admin',
      body: {
        activeProvider,
        codEnabled,
        providers: {
          moyasar: {
            publishableKey: document.getElementById('moyPubKey').value,
            secretKey: document.getElementById('moySecKey').value
          },
          tap: {
            publicKey: document.getElementById('tapPubKey').value,
            secretKey: document.getElementById('tapSecKey').value
          },
          paytabs: {
            profileId: document.getElementById('ptProfileId').value,
            serverKey: document.getElementById('ptServerKey').value
          }
        }
      }
    });
    CATALOG = await api('/api/catalog');
    renderCatalog();
    await loadAdminBootstrap();
    showToast('تم حفظ إعدادات بوابة الدفع ✅', `البوابة الفعالة الآن: ${CATALOG.payment.providerLabel}`, 'fa-credit-card');
  } catch (e) {
    showToast('خطأ في حفظ الدفع', e.message, 'fa-circle-xmark');
  }
}

async function testGatewayConnection(provider) {
  await saveAdminPaymentSettings();
  try {
    const res = await api('/api/admin/payment/test', { method: 'POST', role: 'admin', body: { provider } });
    showToast(res.ok ? 'اتصال ناجح ببوابة الدفع ✅' : 'نتيجة فحص الاتصال ⚠️', res.message, res.ok ? 'fa-circle-check' : 'fa-triangle-exclamation');
  } catch (e) {
    showToast('فشل اختبار الاتصال', e.message, 'fa-circle-xmark');
  }
}

async function saveAdminGeneralAndWaSettings() {
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      role: 'admin',
      body: {
        vatNumber: document.getElementById('admVatNumber').value,
        vatRate: Number(document.getElementById('admVatRate').value),
        extraKiloPrice: Number(document.getElementById('admExtraKiloPrice').value),
        offerTimeoutSec: Number(document.getElementById('admOfferTimeout').value)
      }
    });
    await api('/api/admin/notifications', {
      method: 'PUT',
      role: 'admin',
      body: {
        whatsapp: {
          enabled: document.getElementById('waEnabled').value === 'true',
          phoneNumberId: document.getElementById('waPhoneId').value,
          accessToken: document.getElementById('waToken').value
        }
      }
    });
    CATALOG = await api('/api/catalog');
    showToast('تم حفظ الإعدادات بنجاح ✅', 'تم تحديث الرقم الضريبي وإعدادات الواتساب والتشغيل.', 'fa-check');
  } catch (e) {
    showToast('خطأ', e.message, 'fa-circle-xmark');
  }
}

async function adminReassignOrder(orderId) {
  const driverId = document.getElementById(`reassignDrv-${orderId}`).value;
  try {
    await api(`/api/admin/orders/${orderId}/assign`, { method: 'POST', role: 'admin', body: { driverId } });
    showToast('تم تحويل الطلب للمندوب الجديد', 'وصل إشعار فوري للمندوب المختار.', 'fa-truck-fast');
    await loadAdminBootstrap();
  } catch (e) {
    showToast('تنبيه', e.message, 'fa-circle-info');
  }
}

async function adminSaveCatalogPrice(col, id) {
  const price = Number(document.getElementById(`admCatPrice-${id}`).value);
  await api(`/api/admin/catalog/${col}/${id}`, { method: 'PUT', role: 'admin', body: { price } });
  CATALOG = await api('/api/catalog');
  renderCatalog();
  showToast('تم تحديث السعر فوراً ✅', 'ظهر السعر الجديد في تطبيق العميل.', 'fa-tags');
}

window.addEventListener('DOMContentLoaded', initApp);
