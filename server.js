/*
 * Shaaba Laundry System - backend (zero framework, Node 18+)
 * Roles: customer / driver / branch / admin
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let webpush = null;
try { webpush = require('web-push'); } catch (e) { /* push disabled if library missing */ }

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const now = () => Date.now();
const iso = (t) => new Date(t || Date.now()).toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const uid = (p) => p + crypto.randomBytes(5).toString('hex').toUpperCase();

function hashSecret(s) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(s), salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function verifySecret(s, stored) {
  if (!stored || !s) return false;
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(String(s), salt, 32);
  const hb = Buffer.from(h, 'hex');
  return hb.length === calc.length && crypto.timingSafeEqual(hb, calc);
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function normalizePhone(p) {
  let s = String(p || '').replace(/[^\d]/g, '');
  if (s.startsWith('00966')) s = s.slice(5);
  if (s.startsWith('966')) s = s.slice(3);
  if (s.length === 9 && s.startsWith('5')) s = '0' + s;
  if (!/^05\d{8}$/.test(s)) throw httpError(400, 'رقم الجوال غير صحيح، يجب أن يكون بصيغة 05xxxxxxxx');
  return s;
}
function mask(v) {
  if (!v) return '';
  return v.length <= 8 ? '••••' : v.slice(0, 6) + '••••' + v.slice(-4);
}
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const b = rateBuckets.get(key);
  if (!b || b.resetAt < now()) {
    rateBuckets.set(key, { count: 1, resetAt: now() + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > max) throw httpError(429, 'محاولات كثيرة، يرجى المحاولة بعد قليل');
}

/* ------------------------------------------------------------------ */
/* Database (in-memory + debounced persistence)                        */
/* ------------------------------------------------------------------ */
function seed() {
  const branches = [
    { id: 'BR-ATHEER', name: 'فرع حي الأثير الرئيسي', city: 'الدمام', username: 'atheer' },
    { id: 'BR-DAHIA', name: 'فرع سيبويه - ضاحية الملك فهد', city: 'الدمام', username: 'dahia' },
    { id: 'BR-OROBA', name: 'فرع حي العروبة', city: 'الدمام', username: 'oroba' },
    { id: 'BR-OMAR', name: 'فرع شارع عمر بن الخطاب', city: 'الدمام', username: 'omar' },
    { id: 'BR-AZIZIA', name: 'فرع العزيزية - الخبر', city: 'الخبر', username: 'azizia' },
    { id: 'BR-AQRABIA', name: 'فرع العقربية - الخبر', city: 'الخبر', username: 'aqrabia' }
  ].map((b) => ({ ...b, passwordHash: hashSecret('123456'), active: true }));

  const zones = [
    { id: 'Z-DAM-1', city: 'الدمام', name: 'الأثير والفيصلية والندى', branchId: 'BR-ATHEER', lat: 26.4207, lng: 50.0888 },
    { id: 'Z-DAM-2', city: 'الدمام', name: 'ضاحية الملك فهد', branchId: 'BR-DAHIA', lat: 26.455, lng: 49.985 },
    { id: 'Z-DAM-3', city: 'الدمام', name: 'العروبة والمنار وبدر', branchId: 'BR-OROBA', lat: 26.395, lng: 50.045 },
    { id: 'Z-DAM-4', city: 'الدمام', name: 'الشاطئ والمزروعية والجامعيين', branchId: 'BR-OMAR', lat: 26.467, lng: 50.115 },
    { id: 'Z-KHB-1', city: 'الخبر', name: 'العزيزية والخزامى والشراع', branchId: 'BR-AZIZIA', lat: 26.2172, lng: 50.1971 },
    { id: 'Z-KHB-2', city: 'الخبر', name: 'العقربية والعليا والراكة', branchId: 'BR-AQRABIA', lat: 26.298, lng: 50.184 }
  ].map((z) => ({ ...z, active: true }));

  const drivers = [
    { id: 'DRV-1', name: 'فهد الدوسري', phone: '0501112233', city: 'الدمام', zoneId: 'Z-DAM-1', backupZoneIds: ['Z-DAM-3'] },
    { id: 'DRV-2', name: 'عبد الله الشمري', phone: '0502223344', city: 'الدمام', zoneId: 'Z-DAM-2', backupZoneIds: ['Z-DAM-1'] },
    { id: 'DRV-3', name: 'سالم القحطاني', phone: '0503334455', city: 'الدمام', zoneId: 'Z-DAM-3', backupZoneIds: ['Z-DAM-4'] },
    { id: 'DRV-4', name: 'محمد الغامدي', phone: '0504445566', city: 'الدمام', zoneId: 'Z-DAM-4', backupZoneIds: ['Z-DAM-2'] },
    { id: 'DRV-5', name: 'خالد العتيبي', phone: '0505556677', city: 'الخبر', zoneId: 'Z-KHB-1', backupZoneIds: ['Z-KHB-2'] },
    { id: 'DRV-6', name: 'ياسر الحربي', phone: '0506667788', city: 'الخبر', zoneId: 'Z-KHB-2', backupZoneIds: ['Z-KHB-1'] }
  ].map((d) => ({ ...d, pinHash: hashSecret('1234'), active: true, onDuty: true, location: null }));

  return {
    version: 2,
    counters: { order: 9100 },
    settings: {
      brandName: 'مغاسل سحابة',
      vatNumber: '310123456700003',
      vatRate: 0.15,
      extraKiloPrice: 9,
      publicBaseUrl: '',
      demoMode: true,
      requireScalePhoto: false,
      dispatch: { offerTimeoutSec: 300 },
      referral: { enabled: true, rewardReferrer: 20, rewardNewCustomer: 15 },
      subscriptionAlerts: { lowBalancePercent: 20, expiryDaysBefore: 3 }
    },
    payment: {
      activeProvider: 'sandbox',
      codEnabled: true,
      providers: {
        moyasar: { publishableKey: '', secretKey: '' },
        tap: { publicKey: '', secretKey: '' },
        paytabs: { profileId: '', serverKey: '', region: 'SAU' }
      }
    },
    notifications: {
      whatsapp: { enabled: false, phoneNumberId: '', accessToken: '', templateName: 'shaaba_update', languageCode: 'ar' }
    },
    admins: [{ id: 'ADM-1', username: 'admin', name: 'مدير النظام', passwordHash: hashSecret('shaaba2026') }],
    branches,
    zones,
    drivers,
    customers: [
      {
        id: 'C-DEMO1',
        name: 'أحمد محمد العتيبي',
        phone: '0551234567',
        zoneId: 'Z-DAM-1',
        address: 'الدمام، حي الأثير، شارع الملك سعود، فيلا 14',
        lat: 26.4207,
        lng: 50.0888,
        walletBalance: 35,
        referralCode: 'SHAABA1',
        referredBy: null,
        referralRewarded: false,
        subscription: {
          active: true,
          planId: 'SUB-50',
          planName: 'باقة العائلة الشهرية',
          totalKilos: 50,
          usedKilos: 14.5,
          remainingKilos: 35.5,
          carriedOver: 0,
          startedAt: iso(),
          expiresAt: iso(now() + 25 * 86400000),
          autoRenew: true,
          alerts: { low: false, expiry: false },
          renewalPaymentId: null
        },
        createdAt: iso()
      },
      {
        id: 'C-DEMO2',
        name: 'سلطان خالد الدوسري',
        phone: '0509988776',
        zoneId: 'Z-KHB-1',
        address: 'الخبر، حي العزيزية، شارع الستين، منزل 28',
        lat: 26.2172,
        lng: 50.1971,
        walletBalance: 15,
        referralCode: 'SHAABA2',
        referredBy: 'C-DEMO1',
        referralRewarded: false,
        subscription: {
          active: true,
          planId: 'SUB-25',
          planName: 'باقة سحابة الشهرية (أفراد)',
          totalKilos: 25,
          usedKilos: 5,
          remainingKilos: 20,
          carriedOver: 0,
          startedAt: iso(),
          expiresAt: iso(now() + 28 * 86400000),
          autoRenew: true,
          alerts: { low: false, expiry: false },
          renewalPaymentId: null
        },
        createdAt: iso()
      }
    ],
    kiloPackages: [
      { id: 'PKG-5-WI', name: 'باقة 5 كيلو (غسيل وكي)', kilos: 5, service: 'wash_iron', serviceType: 'غسيل وكي', price: 49, oldPrice: 60, approxPieces: 'تكفي تقريباً 15 - 20 قطعة', icon: 'fa-shirt', badge: 'للأفراد', active: true },
      { id: 'PKG-10-WI', name: 'باقة 10 كيلو (غسيل وكي)', kilos: 10, service: 'wash_iron', serviceType: 'غسيل وكي', price: 89, oldPrice: 115, approxPieces: 'تكفي تقريباً 30 - 40 قطعة', icon: 'fa-layer-group', badge: 'الأكثر طلباً', popular: true, active: true },
      { id: 'PKG-15-WI', name: 'باقة 15 كيلو (غسيل وكي عائلي)', kilos: 15, service: 'wash_iron', serviceType: 'غسيل وكي', price: 125, oldPrice: 165, approxPieces: 'تكفي تقريباً 45 - 60 قطعة', icon: 'fa-boxes-stacked', badge: 'عائلي', active: true },
      { id: 'PKG-5-WF', name: 'باقة 5 كيلو (غسيل وطي بدون كي)', kilos: 5, service: 'wash_fold', serviceType: 'غسيل وطي', price: 35, oldPrice: 45, approxPieces: 'للملابس اليومية والقطنيات', icon: 'fa-hands-bubbles', badge: 'اقتصادية', active: true }
    ],
    subscriptions: [
      { id: 'SUB-25', name: 'باقة سحابة الشهرية (أفراد)', kilos: 25, price: 199, oldPrice: 250, validityDays: 30, badge: 'توفير 20%', active: true, perks: ['25 كيلو غسيل وكي طوال الشهر', 'تُستهلك على عدة طلبات', 'استلام وتوصيل مجاني'] },
      { id: 'SUB-50', name: 'باقة العائلة الشهرية', kilos: 50, price: 349, oldPrice: 460, validityDays: 30, badge: 'الأكثر مبيعاً', popular: true, active: true, perks: ['50 كيلو غسيل وكي طوال الشهر', 'أولوية في مواعيد الاستلام', 'استلام وتوصيل مجاني غير محدود'] },
      { id: 'SUB-80', name: 'باقة سحابة VIP الشهرية', kilos: 80, price: 499, oldPrice: 680, validityDays: 30, badge: 'توفير 27%', active: true, perks: ['80 كيلو غسيل وكي طوال الشهر', 'توصيل سريع مجاني', 'تغليف وتعطير خاص'] }
    ],
    specialItems: [
      { id: 'SPC-CARPET', category: 'سجاد ومفروشات', name: 'غسيل سجاد (بالمتر المربع)', unit: 'م²', price: 12, icon: 'fa-rug', description: 'غسيل آلي عميق وإزالة البقع مع التجفيف والتعطير', active: true },
      { id: 'SPC-BLANKET-L', category: 'سجاد ومفروشات', name: 'بطانية / مفرش مزدوج', unit: 'قطعة', price: 35, icon: 'fa-bed', description: 'غسيل وتعقيم وتغليف', active: true },
      { id: 'SPC-BLANKET-S', category: 'سجاد ومفروشات', name: 'بطانية / لحاف مفرد', unit: 'قطعة', price: 25, icon: 'fa-mattress-pillow', description: 'عناية بنعومة الأنسجة', active: true },
      { id: 'SPC-SHOES', category: 'أحذية', name: 'غسيل أحذية (رياضي / كلاسيك)', unit: 'زوج', price: 25, icon: 'fa-shoe-prints', description: 'تنظيف عميق وإزالة الروائح', active: true },
      { id: 'SPC-SUIT', category: 'ملابس خاصة', name: 'فستان سهرة / بدلة / بشت', unit: 'قطعة', price: 35, icon: 'fa-user-tie', description: 'غسيل خاص وكي بالبخار وتغليف معلق', active: true },
      { id: 'SPC-THOBE', category: 'ملابس خاصة', name: 'ثوب رجالي / عباية', unit: 'قطعة', price: 8, icon: 'fa-vest', description: 'غسيل وكي احترافي', active: true }
    ],
    coupons: [
      { id: 'CPN-1', code: 'WELCOME10', type: 'percent', value: 10, minTotal: 40, maxUses: 1000, usedCount: 0, onePerCustomer: true, usedBy: [], expiresAt: '2027-12-31', active: true }
    ],
    orders: [
      {
        id: 'SHB-9099',
        createdAt: iso(),
        type: 'standard',
        customerId: 'C-DEMO1',
        customerName: 'أحمد محمد العتيبي',
        customerPhone: '0551234567',
        city: 'الدمام',
        zoneId: 'Z-DAM-1',
        zoneName: 'الأثير والفيصلية والندى',
        branchId: 'BR-ATHEER',
        branchName: 'فرع حي الأثير الرئيسي',
        driverId: 'DRV-1',
        driverName: 'فهد الدوسري',
        driverPhone: '0501112233',
        triedDriverIds: [],
        rejections: [],
        timeouts: [],
        offeredAt: iso(),
        offerExpiresAt: iso(now() + 300000),
        acceptedAt: null,
        address: 'الدمام، حي الأثير، شارع الملك سعود، فيلا 14',
        lat: 26.4207,
        lng: 50.0888,
        pickupSlot: 'فوري (خلال 45 دقيقة)',
        notes: 'الرجاء الاتصال عند الوصول',
        useSubscription: false,
        estimatedKilos: 10,
        actualKilos: null,
        scalePhotoUrl: null,
        items: [
          { id: 'PKG-10-WI', name: 'باقة 10 كيلو (غسيل وكي)', qty: 1, price: 89, type: 'kilo_package', kilos: 10 },
          { id: 'SPC-BLANKET-L', name: 'بطانية / مفرش مزدوج', qty: 1, price: 35, type: 'special', kilos: 0 }
        ],
        pricing: { subtotal: 124, discount: 0, couponCode: null, walletUsed: 0, total: 124, vat: 16.17, extraKilos: 0, extraCost: 0, kiloChargeLabel: '' },
        paymentMethod: 'online',
        paymentStatus: 'paid',
        extraPaymentStatus: 'none',
        status: 'pending_driver',
        history: [
          { status: 'new', label: 'تم إنشاء الطلب وسداده إلكترونياً', at: iso() },
          { status: 'pending_driver', label: 'تم عرض الطلب على المندوب فهد الدوسري (مهلة القبول 5 دقائق)', at: iso() }
        ],
        rating: null
      }
    ],
    payments: [],
    notifications: [],
    outbox: [],
    sessions: {},
    pushSubs: []
  };
}

let db;
if (fs.existsSync(DB_PATH)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (db.version !== 2) throw new Error('old schema');
  } catch (e) {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_PATH + '.bak-' + Date.now());
    db = seed();
  }
} else {
  db = seed();
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_PATH);
  }, 300);
}
save();

/* Web push (VAPID) */
if (webpush) {
  if (!db.settings.vapid) {
    db.settings.vapid = webpush.generateVAPIDKeys();
    save();
  }
  webpush.setVapidDetails('mailto:info@shaaba.sa', db.settings.vapid.publicKey, db.settings.vapid.privateKey);
}

/* ------------------------------------------------------------------ */
/* Lookups & view models                                               */
/* ------------------------------------------------------------------ */
const findZone = (id) => db.zones.find((z) => z.id === id);
const findBranch = (id) => db.branches.find((b) => b.id === id);
const findDriver = (id) => db.drivers.find((d) => d.id === id);
const findCustomer = (id) => db.customers.find((c) => c.id === id);
const findOrder = (id) => db.orders.find((o) => o.id === id);

function publicCustomer(c) {
  return {
    id: c.id, name: c.name, phone: c.phone, zoneId: c.zoneId, address: c.address, lat: c.lat, lng: c.lng,
    walletBalance: round2(c.walletBalance), referralCode: c.referralCode, subscription: c.subscription
  };
}
function publicDriver(d) {
  return { id: d.id, name: d.name, phone: d.phone, city: d.city, zoneId: d.zoneId, backupZoneIds: d.backupZoneIds, active: d.active, onDuty: d.onDuty, location: d.location };
}
function publicBranch(b) {
  return { id: b.id, name: b.name, city: b.city, username: b.username, active: b.active };
}
function outstanding(o) {
  let due = 0;
  if (o.paymentStatus !== 'paid') due += o.pricing.total;
  if (o.extraPaymentStatus === 'pending') due += o.pricing.extraCost;
  return round2(due);
}
function buildZatcaTlv(o) {
  const grandTotal = round2(o.pricing.total + (o.pricing.extraCost || 0));
  const vatAmount = vatOf(grandTotal);
  const fields = [
    [1, db.settings.brandName || 'مغاسل سحابة'],
    [2, db.settings.vatNumber || '310123456700003'],
    [3, o.createdAt || iso()],
    [4, grandTotal.toFixed(2)],
    [5, vatAmount.toFixed(2)]
  ];
  const bufs = fields.map(([tag, val]) => {
    const vb = Buffer.from(String(val), 'utf8');
    return Buffer.concat([Buffer.from([tag, vb.length]), vb]);
  });
  return Buffer.concat(bufs).toString('base64');
}
function orderView(o) {
  const grandTotal = round2(o.pricing.total + (o.pricing.extraCost || 0));
  return {
    ...o,
    outstanding: outstanding(o),
    grandTotal,
    grandVat: vatOf(grandTotal),
    zatcaTlv: buildZatcaTlv(o)
  };
}
function vatOf(total) {
  const r = db.settings.vatRate || 0;
  return round2(total - total / (1 + r));
}
function baseUrl(req) {
  if (db.settings.publicBaseUrl) return db.settings.publicBaseUrl.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let proto = req.headers['x-forwarded-proto'];
  if (!proto) proto = /^(localhost|127\.|192\.168\.)/.test(host) ? 'http' : 'https';
  return `${proto.split(',')[0]}://${host}`;
}
function addHistory(o, status, label) {
  o.history.push({ status, label, at: iso() });
}

/* ------------------------------------------------------------------ */
/* Realtime: SSE + web push + WhatsApp                                 */
/* ------------------------------------------------------------------ */
let sseClients = [];
function emitTo(role, userId, type, data) {
  const msg = `data: ${JSON.stringify({ type, data })}\n\n`;
  sseClients.forEach((c) => {
    if (c.role === role && (role === 'admin' || c.userId === userId)) {
      try { c.res.write(msg); } catch (e) { /* ignore */ }
    }
  });
}
function emitOrder(o, type, extraDriverIds = []) {
  emitTo('customer', o.customerId, type, { orderId: o.id, status: o.status });
  if (o.driverId) emitTo('driver', o.driverId, type, { orderId: o.id, status: o.status });
  extraDriverIds.forEach((id) => id && id !== o.driverId && emitTo('driver', id, type, { orderId: o.id }));
  if (o.branchId) emitTo('branch', o.branchId, type, { orderId: o.id, status: o.status });
  emitTo('admin', null, type, { orderId: o.id, status: o.status });
}

async function sendPush(role, userId, payload) {
  if (!webpush) return;
  const subs = db.pushSubs.filter((s) => s.role === role && (role === 'admin' || s.userId === userId));
  for (const s of subs) {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.pushSubs = db.pushSubs.filter((x) => x !== s);
        save();
      }
    }
  }
}

function cleanWaText(t) {
  return String(t).replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 900);
}
async function sendWhatsApp(phone, text) {
  const cfg = db.notifications.whatsapp;
  const entry = { id: uid('MSG-'), channel: 'whatsapp', to: phone, text, status: 'queued', error: '', createdAt: iso() };
  db.outbox.unshift(entry);
  db.outbox = db.outbox.slice(0, 300);
  if (!cfg.enabled) {
    entry.status = 'disabled';
    save();
    return entry;
  }
  try {
    const to = '966' + phone.slice(1);
    const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: cfg.templateName,
          language: { code: cfg.languageCode || 'ar' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: cleanWaText(text) }] }]
        }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) entry.status = 'sent';
    else {
      entry.status = 'failed';
      entry.error = (j.error && j.error.message) || `HTTP ${r.status}`;
    }
  } catch (e) {
    entry.status = 'failed';
    entry.error = e.message;
  }
  save();
  return entry;
}

function notifyCustomer(customerId, title, body, url = '/#orders') {
  const c = findCustomer(customerId);
  if (!c) return;
  db.notifications.unshift({ id: uid('N-'), userType: 'customer', userId: customerId, title, body, url, read: false, createdAt: iso() });
  db.notifications = db.notifications.slice(0, 2000);
  save();
  emitTo('customer', customerId, 'notification', { title, body });
  sendPush('customer', customerId, { title, body, url });
  sendWhatsApp(c.phone, `${title} - ${body}`);
}
function notifyDriver(driverId, title, body) {
  emitTo('driver', driverId, 'notification', { title, body });
  sendPush('driver', driverId, { title, body, url: '/driver/' });
}
function notifyBranch(branchId, title, body) {
  emitTo('branch', branchId, 'notification', { title, body });
  sendPush('branch', branchId, { title, body, url: '/branch/' });
}
function notifyAdmins(title, body) {
  emitTo('admin', null, 'notification', { title, body });
  sendPush('admin', null, { title, body, url: '/admin/' });
}

/* ------------------------------------------------------------------ */
/* Dispatch: offer order to zone driver, auto re-assign on timeout     */
/* ------------------------------------------------------------------ */
function dispatchOrder(o, reasonLabel) {
  const zone = findZone(o.zoneId);
  const tried = new Set(o.triedDriverIds);
  const pool = db.drivers.filter((d) => d.active && d.onDuty && d.city === zone.city && !tried.has(d.id));
  const ranked = [
    ...pool.filter((d) => d.zoneId === o.zoneId),
    ...pool.filter((d) => d.zoneId !== o.zoneId && (d.backupZoneIds || []).includes(o.zoneId)),
    ...pool.filter((d) => d.zoneId !== o.zoneId && !(d.backupZoneIds || []).includes(o.zoneId))
  ];
  const prevDriver = o.driverId;
  const d = ranked[0];
  if (!d) {
    o.status = 'unassigned';
    o.driverId = null;
    o.driverName = '';
    o.driverPhone = '';
    o.offerExpiresAt = null;
    addHistory(o, 'unassigned', 'لا يوجد مندوب متاح حالياً - تم تنبيه الإدارة للتوزيع اليدوي');
    notifyAdmins('⚠️ طلب بدون مندوب', `الطلب ${o.id} في ${zone.city} - ${zone.name} يحتاج توزيع يدوي`);
    emitOrder(o, 'order_updated', [prevDriver]);
    save();
    return;
  }
  o.driverId = d.id;
  o.driverName = d.name;
  o.driverPhone = d.phone;
  o.status = 'pending_driver';
  o.offeredAt = iso();
  o.offerExpiresAt = iso(now() + db.settings.dispatch.offerTimeoutSec * 1000);
  addHistory(o, 'pending_driver', `${reasonLabel ? reasonLabel + ' - ' : ''}تم عرض الطلب على المندوب ${d.name}`);
  notifyDriver(d.id, '🔔 طلب جديد في منطقتك', `${o.id} - ${zone.name} - ${o.pickupSlot}`);
  emitOrder(o, 'order_updated', [prevDriver]);
  save();
}

function releaseOrderResources(o) {
  const c = findCustomer(o.customerId);
  if (c && o.pricing.walletUsed > 0) {
    c.walletBalance = round2(c.walletBalance + o.pricing.walletUsed);
    o.pricing.walletUsed = 0;
  }
  if (o.pricing.couponCode) {
    const cp = db.coupons.find((x) => x.code === o.pricing.couponCode);
    if (cp) {
      cp.usedCount = Math.max(0, cp.usedCount - 1);
      cp.usedBy = cp.usedBy.filter((id) => id !== o.customerId);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */
function priceCart(items) {
  const lines = [];
  let subtotal = 0;
  let kilos = 0;
  for (const it of items || []) {
    const qty = Math.max(0, Math.min(50, parseInt(it.qty, 10) || 0));
    if (!qty) continue;
    let p = db.kiloPackages.find((x) => x.id === it.id && x.active !== false);
    let type = 'kilo_package';
    if (!p) {
      p = db.specialItems.find((x) => x.id === it.id && x.active !== false);
      type = 'special';
    }
    if (!p) throw httpError(400, 'عنصر غير متاح: ' + it.id);
    lines.push({ id: p.id, name: p.name, qty, price: p.price, type, kilos: p.kilos || 0 });
    subtotal += p.price * qty;
    if (type === 'kilo_package') kilos += p.kilos * qty;
  }
  return { lines, subtotal: round2(subtotal), kilos };
}

function evaluateCoupon(code, subtotal, customerId) {
  const cp = db.coupons.find((x) => x.code.toUpperCase() === String(code || '').trim().toUpperCase());
  if (!cp || !cp.active) throw httpError(400, 'كود الخصم غير صحيح');
  if (cp.expiresAt && new Date(cp.expiresAt + 'T23:59:59') < new Date()) throw httpError(400, 'كود الخصم منتهي');
  if (cp.maxUses && cp.usedCount >= cp.maxUses) throw httpError(400, 'تم استنفاد كود الخصم');
  if (cp.onePerCustomer && cp.usedBy.includes(customerId)) throw httpError(400, 'استخدمت هذا الكود من قبل');
  if (subtotal < (cp.minTotal || 0)) throw httpError(400, `الحد الأدنى لاستخدام الكود ${cp.minTotal} ر.س`);
  const discount = cp.type === 'percent' ? round2((subtotal * cp.value) / 100) : Math.min(subtotal, cp.value);
  return { coupon: cp, discount: round2(discount) };
}

function bestKiloCharge(kg) {
  const pkgs = db.kiloPackages.filter((p) => p.active !== false && p.service === 'wash_iron').sort((a, b) => a.kilos - b.kilos);
  const fit = pkgs.find((p) => p.kilos >= kg);
  if (fit) return { amount: fit.price, label: fit.name };
  const biggest = pkgs[pkgs.length - 1];
  const extra = kg - biggest.kilos;
  return { amount: round2(biggest.price + extra * db.settings.extraKiloPrice), label: `${biggest.name} + ${round2(extra)} كجم إضافي` };
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */
function activateSubscription(c, plan) {
  const prev = c.subscription && c.subscription.active ? c.subscription : null;
  const carry = prev ? prev.remainingKilos : 0;
  c.subscription = {
    active: true,
    planId: plan.id,
    planName: plan.name,
    totalKilos: round2(plan.kilos + carry),
    usedKilos: 0,
    remainingKilos: round2(plan.kilos + carry),
    carriedOver: carry,
    startedAt: iso(),
    expiresAt: iso(now() + (plan.validityDays || 30) * 86400000),
    autoRenew: prev ? !!prev.autoRenew : true,
    alerts: { low: false, expiry: false },
    renewalPaymentId: null
  };
  notifyCustomer(c.id, '🎉 تم تفعيل باقتك الشهرية', `${plan.name}: رصيدك الآن ${c.subscription.remainingKilos} كجم`, '/#wallet');
}

function checkSubscriptionAlerts(c) {
  const s = c.subscription;
  if (!s || !s.active) return;
  const cfg = db.settings.subscriptionAlerts;
  if (!s.alerts.low && s.remainingKilos <= (s.totalKilos * cfg.lowBalancePercent) / 100) {
    s.alerts.low = true;
    notifyCustomer(c.id, 'رصيد باقتك قارب على الانتهاء', `المتبقي ${s.remainingKilos} كجم من ${s.totalKilos} كجم - جدد الآن`, '/#wallet');
  }
  const msLeft = new Date(s.expiresAt).getTime() - now();
  if (!s.alerts.expiry && msLeft > 0 && msLeft <= cfg.expiryDaysBefore * 86400000) {
    s.alerts.expiry = true;
    notifyCustomer(
      c.id,
      'باقتك الشهرية تنتهي قريباً',
      `تنتهي في ${new Date(s.expiresAt).toLocaleDateString('ar-SA')}${s.autoRenew ? ' - التجديد التلقائي مفعل وسيصلك رابط الدفع' : ''}`,
      '/#wallet'
    );
  }
  if (msLeft <= 0) {
    s.active = false;
    if (s.autoRenew) {
      notifyCustomer(c.id, 'انتهت باقتك الشهرية', 'اضغط هنا لتجديدها بنفس الباقة والرصيد المتبقي يُرحّل', '/#wallet');
    } else {
      notifyCustomer(c.id, 'انتهت باقتك الشهرية', 'يمكنك الاشتراك من جديد في أي وقت', '/#wallet');
    }
  }
  save();
}

/* ------------------------------------------------------------------ */
/* Payment gateway adapters                                            */
/* ------------------------------------------------------------------ */
const PAYTABS_HOSTS = {
  SAU: 'https://secure.paytabs.sa',
  ARE: 'https://secure.paytabs.com',
  EGY: 'https://secure-egypt.paytabs.com',
  OMN: 'https://secure-oman.paytabs.com',
  JOR: 'https://secure-jordan.paytabs.com',
  GLOBAL: 'https://secure-global.paytabs.com'
};

async function readJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { raw: t }; }
}

const adapters = {
  sandbox: {
    label: 'وضع تجريبي (بدون تحصيل حقيقي)',
    async create(p) {
      return { ref: p.id, redirectUrl: `/pay/sandbox.html?pid=${p.id}` };
    },
    async verify(p) {
      return p.sandboxResult || 'pending';
    },
    async test() {
      return { ok: true, message: 'الوضع التجريبي يعمل' };
    }
  },
  moyasar: {
    label: 'ميسر Moyasar',
    auth() {
      const k = db.payment.providers.moyasar.secretKey;
      if (!k) throw httpError(400, 'مفتاح ميسر السري (Secret Key) غير مُعد');
      return 'Basic ' + Buffer.from(k + ':').toString('base64');
    },
    async create(p, { returnUrl, description }) {
      const r = await fetch('https://api.moyasar.com/v1/invoices', {
        method: 'POST',
        headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Math.round(p.amount * 100),
          currency: 'SAR',
          description,
          success_url: returnUrl,
          back_url: returnUrl,
          metadata: { pid: p.id }
        })
      });
      const j = await readJson(r);
      if (!r.ok || !j.url) throw httpError(502, 'ميسر: ' + (j.message || `HTTP ${r.status}`));
      return { ref: j.id, redirectUrl: j.url };
    },
    async verify(p) {
      const r = await fetch(`https://api.moyasar.com/v1/invoices/${encodeURIComponent(p.providerRef)}`, { headers: { Authorization: this.auth() } });
      const j = await readJson(r);
      if (!r.ok) return 'pending';
      if (j.status === 'paid' && Number(j.amount) === Math.round(p.amount * 100)) return 'paid';
      if (['failed', 'canceled', 'expired', 'void'].includes(j.status)) return 'failed';
      return 'pending';
    },
    async test() {
      const r = await fetch('https://api.moyasar.com/v1/payments', { headers: { Authorization: this.auth() } });
      if (r.status === 401 || r.status === 403) return { ok: false, message: 'المفتاح السري مرفوض من ميسر' };
      return { ok: r.ok, message: r.ok ? 'تم قبول المفتاح السري من ميسر' : `استجابة غير متوقعة HTTP ${r.status}` };
    }
  },
  tap: {
    label: 'تاب Tap Payments',
    auth() {
      const k = db.payment.providers.tap.secretKey;
      if (!k) throw httpError(400, 'مفتاح تاب السري (Secret Key) غير مُعد');
      return 'Bearer ' + k;
    },
    async create(p, { returnUrl, description, customer }) {
      const r = await fetch('https://api.tap.company/v2/charges', {
        method: 'POST',
        headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: p.amount,
          currency: 'SAR',
          description,
          reference: { transaction: p.id, order: p.refId || p.id },
          customer: { first_name: customer.name || 'عميل', phone: { country_code: '966', number: customer.phone.slice(1) } },
          source: { id: 'src_all' },
          redirect: { url: returnUrl }
        })
      });
      const j = await readJson(r);
      const url = j.transaction && j.transaction.url;
      if (!r.ok || !url) throw httpError(502, 'تاب: ' + ((j.errors && j.errors[0] && j.errors[0].description) || `HTTP ${r.status}`));
      return { ref: j.id, redirectUrl: url };
    },
    async verify(p) {
      const r = await fetch(`https://api.tap.company/v2/charges/${encodeURIComponent(p.providerRef)}`, { headers: { Authorization: this.auth() } });
      const j = await readJson(r);
      if (!r.ok) return 'pending';
      if (j.status === 'CAPTURED' && round2(j.amount) === round2(p.amount)) return 'paid';
      if (['FAILED', 'DECLINED', 'CANCELLED', 'ABANDONED', 'RESTRICTED', 'VOID', 'TIMEDOUT'].includes(j.status)) return 'failed';
      return 'pending';
    },
    async test() {
      const r = await fetch('https://api.tap.company/v2/charges/chg_connection_test', { headers: { Authorization: this.auth() } });
      if (r.status === 401 || r.status === 403) return { ok: false, message: 'المفتاح السري مرفوض من تاب' };
      return { ok: true, message: 'تم قبول المفتاح السري من تاب' };
    }
  },
  paytabs: {
    label: 'بيتابس PayTabs',
    cfg() {
      const c = db.payment.providers.paytabs;
      if (!c.profileId || !c.serverKey) throw httpError(400, 'بيانات بيتابس (Profile ID و Server Key) غير مكتملة');
      return { ...c, host: PAYTABS_HOSTS[c.region] || PAYTABS_HOSTS.SAU };
    },
    async create(p, { returnUrl, description, customer }) {
      const c = this.cfg();
      const r = await fetch(`${c.host}/payment/request`, {
        method: 'POST',
        headers: { authorization: c.serverKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile_id: Number(c.profileId),
          tran_type: 'sale',
          tran_class: 'ecom',
          cart_id: p.id,
          cart_currency: 'SAR',
          cart_amount: p.amount,
          cart_description: description,
          return: returnUrl,
          hide_shipping: true,
          customer_details: { name: customer.name || 'Customer', phone: customer.phone, email: `${customer.phone}@shaaba.sa`, street1: 'NA', city: 'Dammam', country: 'SA' }
        })
      });
      const j = await readJson(r);
      if (!r.ok || !j.redirect_url) throw httpError(502, 'بيتابس: ' + (j.message || `HTTP ${r.status}`));
      return { ref: j.tran_ref, redirectUrl: j.redirect_url };
    },
    async verify(p) {
      const c = this.cfg();
      const r = await fetch(`${c.host}/payment/query`, {
        method: 'POST',
        headers: { authorization: c.serverKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: Number(c.profileId), tran_ref: p.providerRef })
      });
      const j = await readJson(r);
      const st = j.payment_result && j.payment_result.response_status;
      if (st === 'A' && round2(j.cart_amount) === round2(p.amount)) return 'paid';
      if (['D', 'E', 'V', 'X'].includes(st)) return 'failed';
      return 'pending';
    },
    async test() {
      const c = this.cfg();
      const r = await fetch(`${c.host}/payment/query`, {
        method: 'POST',
        headers: { authorization: c.serverKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: Number(c.profileId), tran_ref: 'TST0000000000000' })
      });
      const j = await readJson(r);
      if (r.status === 401 || /authenticat/i.test(j.message || '')) return { ok: false, message: 'بيانات بيتابس مرفوضة' };
      return { ok: true, message: 'تم قبول بيانات بيتابس' };
    }
  }
};

async function startPayment(req, { purpose, refId, amount, description, customer }) {
  if (amount <= 0) throw httpError(400, 'لا يوجد مبلغ مستحق');
  const provider = db.payment.activeProvider;
  const adapter = adapters[provider];
  const p = { id: uid('PAY-'), purpose, refId, amount: round2(amount), status: 'initiated', provider, customerId: customer.id, createdAt: iso() };
  db.payments.push(p);
  const returnUrl = `${baseUrl(req)}/pay/return?pid=${p.id}`;
  try {
    const r = await adapter.create(p, { returnUrl, description, customer });
    p.providerRef = r.ref;
    p.status = 'pending';
    save();
    return { paymentId: p.id, redirectUrl: r.redirectUrl };
  } catch (e) {
    p.status = 'failed';
    p.error = e.message;
    save();
    throw e;
  }
}

function applyPaymentResult(p, result) {
  if (p.status === 'paid' || p.status === 'failed') return;
  if (result === 'pending') return;
  p.status = result;
  p.completedAt = iso();
  if (result === 'paid') {
    if (p.purpose === 'order') {
      const o = findOrder(p.refId);
      if (o) {
        o.paymentStatus = 'paid';
        addHistory(o, o.status, `تم الدفع الإلكتروني (${round2(p.amount)} ر.س)`);
        if (o.status === 'awaiting_payment') dispatchOrder(o, 'تم تأكيد الدفع');
        else emitOrder(o, 'order_updated');
      }
    } else if (p.purpose === 'balance') {
      const o = findOrder(p.refId);
      if (o) {
        o.paymentStatus = 'paid';
        if (o.extraPaymentStatus === 'pending') o.extraPaymentStatus = 'paid';
        addHistory(o, o.status, `تم سداد المبلغ المتبقي إلكترونياً (${round2(p.amount)} ر.س)`);
        emitOrder(o, 'order_updated');
      }
    } else if (p.purpose === 'subscription') {
      const c = findCustomer(p.customerId);
      const plan = db.subscriptions.find((s) => s.id === p.refId);
      if (c && plan) activateSubscription(c, plan);
    }
  } else if (result === 'failed') {
    if (p.purpose === 'order') {
      const o = findOrder(p.refId);
      if (o && o.status === 'awaiting_payment') {
        o.status = 'cancelled';
        releaseOrderResources(o);
        addHistory(o, 'cancelled', 'فشلت عملية الدفع - تم إلغاء الطلب');
        emitOrder(o, 'order_updated');
      }
    }
  }
  save();
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'حجم البيانات كبير جداً'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function getSession(req, query) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : query.get('token');
  if (!token) return null;
  const s = db.sessions[token];
  if (!s || s.exp < now()) return null;
  return { ...s, token };
}
function createSession(role, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { role, userId, exp: now() + 30 * 86400000 };
  save();
  return token;
}

const routes = [];
function route(method, pattern, roles, handler) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, roles, handler });
}

/* ------------------------------------------------------------------ */
/* Public routes                                                       */
/* ------------------------------------------------------------------ */
route('GET', '/api/health', null, () => ({ ok: true }));

route('GET', '/api/catalog', null, () => ({
  brandName: db.settings.brandName,
  vatRate: db.settings.vatRate,
  extraKiloPrice: db.settings.extraKiloPrice,
  demoMode: db.settings.demoMode,
  referral: db.settings.referral,
  payment: {
    activeProvider: db.payment.activeProvider,
    providerLabel: adapters[db.payment.activeProvider].label,
    codEnabled: db.payment.codEnabled
  },
  pushPublicKey: webpush ? db.settings.vapid.publicKey : null,
  kiloPackages: db.kiloPackages.filter((x) => x.active !== false),
  subscriptions: db.subscriptions.filter((x) => x.active !== false),
  specialItems: db.specialItems.filter((x) => x.active !== false),
  zones: db.zones.filter((z) => z.active).map((z) => ({ id: z.id, city: z.city, name: z.name, lat: z.lat, lng: z.lng, branchName: (findBranch(z.branchId) || {}).name }))
}));

/* Customer OTP login */
const otps = new Map();
route('POST', '/api/auth/otp/request', null, ({ body, req }) => {
  const phone = normalizePhone(body.phone);
  rateLimit('otp:' + phone, 5, 10 * 60000);
  rateLimit('otpip:' + req.socket.remoteAddress, 20, 10 * 60000);
  const code = String(crypto.randomInt(1000, 10000));
  otps.set(phone, { code, exp: now() + 5 * 60000, attempts: 0 });
  // TODO(production): send `code` via an SMS provider (Unifonic / Taqnyat / Msegat)
  return { ok: true, demoCode: db.settings.demoMode ? code : undefined, isNew: !db.customers.some((c) => c.phone === phone) };
});

route('POST', '/api/auth/otp/verify', null, ({ body }) => {
  const phone = normalizePhone(body.phone);
  const entry = otps.get(phone);
  if (!entry || entry.exp < now()) throw httpError(400, 'انتهت صلاحية الرمز، اطلب رمزاً جديداً');
  entry.attempts += 1;
  if (entry.attempts > 5) {
    otps.delete(phone);
    throw httpError(429, 'محاولات كثيرة، اطلب رمزاً جديداً');
  }
  if (String(body.code).trim() !== entry.code) throw httpError(400, 'رمز التحقق غير صحيح');
  otps.delete(phone);

  let c = db.customers.find((x) => x.phone === phone);
  if (!c) {
    const zone = findZone(body.zoneId) || db.zones[0];
    c = {
      id: uid('C-'),
      name: String(body.name || '').trim().slice(0, 60) || 'عميل سحابة',
      phone,
      zoneId: zone.id,
      address: '',
      lat: zone.lat,
      lng: zone.lng,
      walletBalance: 0,
      referralCode: 'SH' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      referredBy: null,
      referralRewarded: false,
      subscription: null,
      createdAt: iso()
    };
    const ref = String(body.referralCode || '').trim().toUpperCase();
    if (ref && db.settings.referral.enabled) {
      const referrer = db.customers.find((x) => x.referralCode === ref);
      if (referrer) {
        c.referredBy = referrer.id;
        c.walletBalance = db.settings.referral.rewardNewCustomer;
      }
    }
    db.customers.push(c);
    if (c.walletBalance > 0) {
      setTimeout(() => notifyCustomer(c.id, '🎁 هدية ترحيبية', `تم إضافة ${c.walletBalance} ر.س إلى محفظتك لأنك سجلت بكود صديق`, '/#wallet'), 500);
    }
  }
  const token = createSession('customer', c.id);
  return { token, customer: publicCustomer(c) };
});

route('POST', '/api/auth/driver', null, ({ body, req }) => {
  const phone = normalizePhone(body.phone);
  rateLimit('drv:' + phone, 8, 10 * 60000);
  rateLimit('drvip:' + req.socket.remoteAddress, 30, 10 * 60000);
  const d = db.drivers.find((x) => x.phone === phone && x.active);
  if (!d || !verifySecret(body.pin, d.pinHash)) throw httpError(401, 'رقم الجوال أو الرمز السري غير صحيح');
  return { token: createSession('driver', d.id), driver: publicDriver(d) };
});

route('POST', '/api/auth/branch', null, ({ body, req }) => {
  rateLimit('br:' + req.socket.remoteAddress, 15, 10 * 60000);
  const b = db.branches.find((x) => x.username === String(body.username || '').trim() && x.active);
  if (!b || !verifySecret(body.password, b.passwordHash)) throw httpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  return { token: createSession('branch', b.id), branch: publicBranch(b) };
});

route('POST', '/api/auth/admin', null, ({ body, req }) => {
  rateLimit('adm:' + req.socket.remoteAddress, 10, 10 * 60000);
  const a = db.admins.find((x) => x.username === String(body.username || '').trim());
  if (!a || !verifySecret(body.password, a.passwordHash)) throw httpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  return { token: createSession('admin', a.id), admin: { id: a.id, name: a.name, username: a.username } };
});

route('POST', '/api/auth/logout', ['customer', 'driver', 'branch', 'admin'], ({ session }) => {
  delete db.sessions[session.token];
  save();
  return { ok: true };
});

route('POST', '/api/push/subscribe', ['customer', 'driver', 'branch', 'admin'], ({ session, body }) => {
  if (!webpush) throw httpError(400, 'الإشعارات غير مفعلة على الخادم');
  if (!body.subscription || !body.subscription.endpoint) throw httpError(400, 'اشتراك غير صالح');
  db.pushSubs = db.pushSubs.filter((s) => s.subscription.endpoint !== body.subscription.endpoint);
  db.pushSubs.push({ role: session.role, userId: session.userId, subscription: body.subscription, createdAt: iso() });
  save();
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* Customer routes                                                     */
/* ------------------------------------------------------------------ */
function me(session) {
  const c = findCustomer(session.userId);
  if (!c) throw httpError(401, 'الحساب غير موجود');
  return c;
}

route('GET', '/api/me', ['customer'], ({ session }) => {
  const c = me(session);
  const orders = db.orders.filter((o) => o.customerId === c.id).slice(0, 50).map(orderView);
  const notifications = db.notifications.filter((n) => n.userType === 'customer' && n.userId === c.id).slice(0, 40);
  return { customer: publicCustomer(c), orders, notifications, unread: notifications.filter((n) => !n.read).length };
});

route('PUT', '/api/me', ['customer'], ({ session, body }) => {
  const c = me(session);
  if (body.name) c.name = String(body.name).trim().slice(0, 60);
  if (body.zoneId && findZone(body.zoneId)) c.zoneId = body.zoneId;
  if (body.address !== undefined) c.address = String(body.address).slice(0, 200);
  if (Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
    c.lat = body.lat;
    c.lng = body.lng;
  }
  save();
  return { customer: publicCustomer(c) };
});

route('POST', '/api/me/notifications/read', ['customer'], ({ session }) => {
  db.notifications.forEach((n) => {
    if (n.userType === 'customer' && n.userId === session.userId) n.read = true;
  });
  save();
  return { ok: true };
});

route('POST', '/api/me/subscription/auto-renew', ['customer'], ({ session, body }) => {
  const c = me(session);
  if (!c.subscription) throw httpError(400, 'لا يوجد اشتراك');
  c.subscription.autoRenew = !!body.enabled;
  save();
  return { subscription: c.subscription };
});

route('POST', '/api/coupons/validate', ['customer'], ({ session, body }) => {
  const { discount, coupon } = evaluateCoupon(body.code, round2(body.subtotal), session.userId);
  return { code: coupon.code, discount };
});

route('POST', '/api/orders', ['customer'], async ({ session, body, req }) => {
  const c = me(session);
  rateLimit('order:' + c.id, 10, 10 * 60000);
  const zone = findZone(body.zoneId);
  if (!zone || !zone.active) throw httpError(400, 'يرجى اختيار منطقة صحيحة');
  const branch = findBranch(zone.branchId);
  const type = body.type === 'quick_pickup' ? 'quick_pickup' : 'standard';
  const { lines, subtotal, kilos } = priceCart(body.items);
  const useSubscription = !!body.useSubscription;

  if (useSubscription && !(c.subscription && c.subscription.active && c.subscription.remainingKilos > 0)) {
    throw httpError(400, 'لا يوجد رصيد في باقتك الشهرية');
  }
  if (type === 'standard' && !lines.length && !useSubscription) throw httpError(400, 'السلة فارغة');

  let discount = 0;
  let couponCode = null;
  if (body.couponCode) {
    const r = evaluateCoupon(body.couponCode, subtotal, c.id);
    discount = r.discount;
    couponCode = r.coupon.code;
  }
  let total = round2(subtotal - discount);
  let walletUsed = 0;
  if (body.useWallet && c.walletBalance > 0 && total > 0) {
    walletUsed = round2(Math.min(c.walletBalance, total));
    total = round2(total - walletUsed);
  }

  let paymentMethod = body.paymentMethod === 'cod' ? 'cod' : 'online';
  if (paymentMethod === 'cod' && !db.payment.codEnabled) throw httpError(400, 'الدفع عند الاستلام غير متاح حالياً');
  if (total === 0) paymentMethod = useSubscription ? 'subscription' : 'prepaid';
  if (type === 'quick_pickup' && total === 0 && !useSubscription) paymentMethod = 'after_weigh';

  const o = {
    id: 'SHB-' + db.counters.order++,
    createdAt: iso(),
    type,
    customerId: c.id,
    customerName: c.name,
    customerPhone: c.phone,
    city: zone.city,
    zoneId: zone.id,
    zoneName: zone.name,
    branchId: branch.id,
    branchName: branch.name,
    driverId: null,
    driverName: '',
    driverPhone: '',
    triedDriverIds: [],
    rejections: [],
    timeouts: [],
    offeredAt: null,
    offerExpiresAt: null,
    acceptedAt: null,
    address: String(body.address || c.address || '').slice(0, 200),
    lat: Number.isFinite(body.lat) ? body.lat : zone.lat,
    lng: Number.isFinite(body.lng) ? body.lng : zone.lng,
    pickupSlot: String(body.pickupSlot || 'فوري (خلال 45 دقيقة)').slice(0, 60),
    notes: String(body.notes || '').slice(0, 300),
    useSubscription,
    estimatedKilos: useSubscription ? Math.max(1, Math.min(50, Number(body.estimatedKilos) || 5)) : kilos,
    actualKilos: null,
    scalePhotoUrl: null,
    items: lines,
    pricing: { subtotal, discount, couponCode, walletUsed, total, vat: vatOf(total), extraKilos: 0, extraCost: 0, kiloChargeLabel: '' },
    paymentMethod,
    paymentStatus: total === 0 && paymentMethod !== 'after_weigh' ? 'paid' : 'pending',
    extraPaymentStatus: 'none',
    status: 'new',
    history: [],
    rating: null
  };
  if (paymentMethod === 'after_weigh') o.paymentStatus = 'pending';

  if (couponCode) {
    const cp = db.coupons.find((x) => x.code === couponCode);
    cp.usedCount += 1;
    cp.usedBy.push(c.id);
  }
  if (walletUsed) c.walletBalance = round2(c.walletBalance - walletUsed);
  c.zoneId = zone.id;
  if (o.address) c.address = o.address;

  db.orders.unshift(o);
  addHistory(o, 'new', 'تم إنشاء الطلب');

  if (paymentMethod === 'online') {
    o.status = 'awaiting_payment';
    addHistory(o, 'awaiting_payment', 'بانتظار إتمام الدفع الإلكتروني');
    save();
    try {
      const pay = await startPayment(req, { purpose: 'order', refId: o.id, amount: total, description: `طلب ${o.id} - مغاسل سحابة`, customer: c });
      return { order: orderView(o), redirectUrl: pay.redirectUrl };
    } catch (e) {
      o.status = 'cancelled';
      releaseOrderResources(o);
      addHistory(o, 'cancelled', 'تعذر بدء الدفع: ' + e.message);
      save();
      throw e;
    }
  }
  dispatchOrder(o, 'تم تأكيد الطلب');
  return { order: orderView(o) };
});

route('POST', '/api/orders/:id/cancel', ['customer'], ({ session, params }) => {
  const o = findOrder(params.id);
  if (!o || o.customerId !== session.userId) throw httpError(404, 'الطلب غير موجود');
  if (!['awaiting_payment', 'pending_driver', 'unassigned', 'new'].includes(o.status)) throw httpError(400, 'لا يمكن إلغاء الطلب بعد قبول المندوب، تواصل مع خدمة العملاء');
  const prev = o.driverId;
  o.status = 'cancelled';
  releaseOrderResources(o);
  addHistory(o, 'cancelled', 'ألغى العميل الطلب');
  emitOrder(o, 'order_updated', [prev]);
  save();
  return { order: orderView(o) };
});

route('GET', '/api/orders/:id/track', ['customer'], ({ session, params }) => {
  const o = findOrder(params.id);
  if (!o || o.customerId !== session.userId) throw httpError(404, 'الطلب غير موجود');
  const d = o.driverId ? findDriver(o.driverId) : null;
  const live = ['driver_en_route', 'out_for_delivery'].includes(o.status);
  return { status: o.status, customer: { lat: o.lat, lng: o.lng }, driver: live && d ? { name: d.name, phone: d.phone, location: d.location } : null };
});

route('POST', '/api/orders/:id/rate', ['customer'], ({ session, params, body }) => {
  const o = findOrder(params.id);
  if (!o || o.customerId !== session.userId) throw httpError(404, 'الطلب غير موجود');
  if (o.status !== 'delivered') throw httpError(400, 'يمكن التقييم بعد التسليم فقط');
  if (o.rating) throw httpError(400, 'تم تقييم هذا الطلب مسبقاً');
  const clamp = (v) => Math.max(1, Math.min(5, parseInt(v, 10) || 5));
  o.rating = { service: clamp(body.service), driver: clamp(body.driver), comment: String(body.comment || '').slice(0, 300), at: iso() };
  emitTo('admin', null, 'order_updated', { orderId: o.id });
  save();
  return { order: orderView(o) };
});

route('POST', '/api/payments/start', ['customer'], async ({ session, body, req }) => {
  const c = me(session);
  if (body.purpose === 'subscription') {
    const plan = db.subscriptions.find((s) => s.id === body.planId && s.active !== false);
    if (!plan) throw httpError(404, 'الباقة غير موجودة');
    return startPayment(req, { purpose: 'subscription', refId: plan.id, amount: plan.price, description: `${plan.name} - مغاسل سحابة`, customer: c });
  }
  if (body.purpose === 'balance') {
    const o = findOrder(body.orderId);
    if (!o || o.customerId !== c.id) throw httpError(404, 'الطلب غير موجود');
    const due = outstanding(o);
    return startPayment(req, { purpose: 'balance', refId: o.id, amount: due, description: `المبلغ المتبقي للطلب ${o.id}`, customer: c });
  }
  throw httpError(400, 'نوع دفع غير معروف');
});

route('GET', '/api/payments/:id', null, ({ params }) => {
  const p = db.payments.find((x) => x.id === params.id);
  if (!p) throw httpError(404, 'عملية الدفع غير موجودة');
  return { id: p.id, amount: p.amount, purpose: p.purpose, status: p.status, provider: p.provider };
});

route('POST', '/api/payments/:id/sandbox', null, ({ params, body }) => {
  if (db.payment.activeProvider !== 'sandbox') throw httpError(403, 'الوضع التجريبي غير مفعل');
  const p = db.payments.find((x) => x.id === params.id);
  if (!p || p.provider !== 'sandbox') throw httpError(404, 'عملية الدفع غير موجودة');
  p.sandboxResult = body.result === 'paid' ? 'paid' : 'failed';
  save();
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* Driver routes                                                       */
/* ------------------------------------------------------------------ */
function meDriver(session) {
  const d = findDriver(session.userId);
  if (!d || !d.active) throw httpError(401, 'حساب المندوب غير مفعل');
  return d;
}
function driverOrder(session, id) {
  const o = findOrder(id);
  if (!o || o.driverId !== session.userId) throw httpError(404, 'الطلب غير موجود أو غير مسند إليك');
  return o;
}

route('GET', '/api/driver/me', ['driver'], ({ session }) => {
  const d = meDriver(session);
  const dayAgo = now() - 86400000;
  const orders = db.orders
    .filter((o) => o.driverId === d.id && (!['delivered', 'cancelled'].includes(o.status) || new Date(o.history[o.history.length - 1].at).getTime() > dayAgo))
    .map(orderView);
  const zone = findZone(d.zoneId);
  return { driver: { ...publicDriver(d), zoneName: zone ? zone.name : '' }, orders, offerTimeoutSec: db.settings.dispatch.offerTimeoutSec, requireScalePhoto: db.settings.requireScalePhoto };
});

route('POST', '/api/driver/duty', ['driver'], ({ session, body }) => {
  const d = meDriver(session);
  d.onDuty = !!body.onDuty;
  save();
  emitTo('admin', null, 'driver_updated', { driverId: d.id });
  return { driver: publicDriver(d) };
});

route('POST', '/api/driver/location', ['driver'], ({ session, body }) => {
  const d = meDriver(session);
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError(400, 'موقع غير صالح');
  d.location = { lat, lng, at: iso() };
  save();
  db.orders
    .filter((o) => o.driverId === d.id && ['driver_en_route', 'out_for_delivery'].includes(o.status))
    .forEach((o) => emitTo('customer', o.customerId, 'driver_location', { orderId: o.id, lat, lng }));
  emitTo('admin', null, 'driver_location', { driverId: d.id, lat, lng });
  return { ok: true };
});

route('POST', '/api/driver/orders/:id/accept', ['driver'], ({ session, params }) => {
  const o = driverOrder(session, params.id);
  if (o.status !== 'pending_driver') throw httpError(400, 'الطلب لم يعد متاحاً للقبول');
  o.status = 'driver_en_route';
  o.acceptedAt = iso();
  o.offerExpiresAt = null;
  addHistory(o, 'driver_en_route', `قبل المندوب ${o.driverName} الطلب وهو في الطريق إليك`);
  notifyCustomer(o.customerId, '🚚 المندوب في الطريق إليك', `${o.driverName} قبل طلبك ${o.id} ويمكنك تتبعه على الخريطة`);
  emitOrder(o, 'order_updated');
  save();
  return { order: orderView(o) };
});

route('POST', '/api/driver/orders/:id/reject', ['driver'], ({ session, params, body }) => {
  const o = driverOrder(session, params.id);
  if (!['pending_driver', 'driver_en_route'].includes(o.status)) throw httpError(400, 'لا يمكن رفض الطلب في هذه المرحلة');
  const reason = String(body.reason || 'بدون سبب').slice(0, 120);
  o.rejections.push({ driverId: o.driverId, reason, at: iso() });
  o.triedDriverIds.push(o.driverId);
  addHistory(o, o.status, `اعتذر المندوب ${o.driverName}: ${reason}`);
  dispatchOrder(o, 'إعادة توجيه بعد اعتذار المندوب');
  return { ok: true };
});

route('POST', '/api/driver/orders/:id/weigh', ['driver'], ({ session, params, body }) => {
  const o = driverOrder(session, params.id);
  if (o.status !== 'driver_en_route') throw httpError(400, 'يجب قبول الطلب والوصول للعميل أولاً');
  const kg = round2(body.actualKilos);
  if (!(kg > 0 && kg <= 200)) throw httpError(400, 'يرجى إدخال وزن صحيح');

  if (body.photo) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.photo);
    if (!m) throw httpError(400, 'صيغة الصورة غير مدعومة');
    const name = `${o.id}-${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[2], 'base64'));
    o.scalePhotoUrl = '/uploads/' + name;
  } else if (db.settings.requireScalePhoto) {
    throw httpError(400, 'يرجى تصوير شاشة الميزان أولاً');
  }

  o.actualKilos = kg;
  const extraPrice = db.settings.extraKiloPrice;
  let msg;
  const c = findCustomer(o.customerId);
  const hasKiloPackage = o.items.some((i) => i.type === 'kilo_package');

  if (o.useSubscription && c && c.subscription) {
    const s = c.subscription;
    const covered = round2(Math.min(kg, s.remainingKilos));
    s.usedKilos = round2(s.usedKilos + covered);
    s.remainingKilos = round2(s.remainingKilos - covered);
    const extra = round2(kg - covered);
    if (extra > 0) {
      o.pricing.extraKilos = extra;
      o.pricing.extraCost = round2(extra * extraPrice);
      o.extraPaymentStatus = 'pending';
      msg = `تم خصم ${covered} كجم من باقتك (نفد الرصيد) ويوجد ${extra} كجم إضافي بقيمة ${o.pricing.extraCost} ر.س`;
    } else {
      msg = `تم خصم ${kg} كجم من باقتك الشهرية - المتبقي ${s.remainingKilos} كجم`;
    }
    checkSubscriptionAlerts(c);
  } else if (!hasKiloPackage && o.type === 'quick_pickup') {
    const charge = bestKiloCharge(kg);
    o.pricing.kiloChargeLabel = charge.label;
    o.pricing.subtotal = round2(o.pricing.subtotal + charge.amount);
    o.pricing.total = round2(o.pricing.total + charge.amount);
    o.pricing.vat = vatOf(o.pricing.total);
    o.paymentStatus = 'pending';
    msg = `الوزن ${kg} كجم - تم احتساب ${charge.label} بقيمة ${charge.amount} ر.س`;
  } else if (kg > o.estimatedKilos && o.estimatedKilos > 0) {
    const extra = round2(kg - o.estimatedKilos);
    o.pricing.extraKilos = extra;
    o.pricing.extraCost = round2(extra * extraPrice);
    o.extraPaymentStatus = 'pending';
    msg = `الوزن ${kg} كجم (الباقة ${o.estimatedKilos} كجم) - فرق ${extra} كجم بقيمة ${o.pricing.extraCost} ر.س`;
  } else {
    msg = `الوزن ${kg} كجم ضمن باقتك - لا توجد رسوم إضافية`;
  }

  o.status = 'picked_up';
  addHistory(o, 'picked_up', `تم الاستلام والوزن: ${msg}`);
  const due = outstanding(o);
  notifyCustomer(o.customerId, '⚖️ تم استلام ملابسك ووزنها', due > 0 ? `${msg}. المبلغ المستحق ${due} ر.س - ادفع إلكترونياً أو عند التسليم` : msg);
  notifyBranch(o.branchId, 'طلب في الطريق للفرع', `${o.id} - ${kg} كجم مع المندوب ${o.driverName}`);
  emitOrder(o, 'order_updated');
  save();
  return { order: orderView(o), message: msg };
});

route('POST', '/api/driver/orders/:id/handover', ['driver'], ({ session, params }) => {
  const o = driverOrder(session, params.id);
  if (o.status !== 'picked_up') throw httpError(400, 'حالة الطلب لا تسمح');
  o.status = 'at_branch';
  addHistory(o, 'at_branch', `سلّم المندوب الملابس إلى ${o.branchName}`);
  notifyBranch(o.branchId, 'وصل طلب جديد للفرع', `${o.id} - ${o.actualKilos} كجم`);
  emitOrder(o, 'order_updated');
  save();
  return { order: orderView(o) };
});

route('POST', '/api/driver/orders/:id/pickup-ready', ['driver'], ({ session, params }) => {
  const o = driverOrder(session, params.id);
  if (o.status !== 'ready') throw httpError(400, 'الطلب ليس جاهزاً بعد');
  o.status = 'out_for_delivery';
  addHistory(o, 'out_for_delivery', `استلم المندوب ${o.driverName} الملابس الجاهزة وهو في الطريق إليك`);
  const due = outstanding(o);
  notifyCustomer(o.customerId, '🚚 ملابسك في الطريق إليك', due > 0 ? `المبلغ المتبقي ${due} ر.س - يمكنك الدفع الآن إلكترونياً أو عند الاستلام` : `المندوب ${o.driverName} في الطريق`);
  emitOrder(o, 'order_updated');
  save();
  return { order: orderView(o) };
});

route('POST', '/api/driver/orders/:id/deliver', ['driver'], ({ session, params, body }) => {
  const o = driverOrder(session, params.id);
  if (o.status !== 'out_for_delivery') throw httpError(400, 'حالة الطلب لا تسمح');
  const due = outstanding(o);
  if (due > 0 && !body.collected) throw httpError(400, `يوجد مبلغ مستحق ${due} ر.س - أكد تحصيله أولاً`);
  if (due > 0) {
    o.paymentStatus = 'paid';
    if (o.extraPaymentStatus === 'pending') o.extraPaymentStatus = 'paid';
    o.collectedByDriver = due;
    if (o.paymentMethod === 'after_weigh') o.paymentMethod = 'cod';
    addHistory(o, o.status, `حصّل المندوب ${due} ر.س عند التسليم (نقداً/شبكة)`);
  }
  o.status = 'delivered';
  o.deliveredAt = iso();
  addHistory(o, 'delivered', 'تم تسليم الملابس للعميل ✅');
  notifyCustomer(o.customerId, '✅ تم تسليم طلبك', `شكراً لثقتك بمغاسل سحابة - قيّم تجربتك للطلب ${o.id}`);

  const c = findCustomer(o.customerId);
  if (c && c.referredBy && !c.referralRewarded && db.settings.referral.enabled) {
    const ref = findCustomer(c.referredBy);
    if (ref) {
      ref.walletBalance = round2(ref.walletBalance + db.settings.referral.rewardReferrer);
      notifyCustomer(ref.id, '🎁 مكافأة دعوة صديق', `أضفنا ${db.settings.referral.rewardReferrer} ر.س إلى محفظتك لأن ${c.name} أكمل أول طلب`, '/#wallet');
    }
    c.referralRewarded = true;
  }
  emitOrder(o, 'order_updated');
  save();
  return { order: orderView(o) };
});

/* ------------------------------------------------------------------ */
/* Branch routes                                                       */
/* ------------------------------------------------------------------ */
route('GET', '/api/branch/me', ['branch'], ({ session }) => {
  const b = findBranch(session.userId);
  if (!b) throw httpError(401, 'الفرع غير موجود');
  const dayAgo = now() - 86400000;
  const orders = db.orders
    .filter((o) => o.branchId === b.id && (['picked_up', 'at_branch', 'washing', 'ready', 'out_for_delivery'].includes(o.status) || (o.status === 'delivered' && new Date(o.deliveredAt).getTime() > dayAgo)))
    .map(orderView);
  return { branch: publicBranch(b), orders };
});

route('POST', '/api/branch/orders/:id/status', ['branch'], ({ session, params, body }) => {
  const o = findOrder(params.id);
  if (!o || o.branchId !== session.userId) throw httpError(404, 'الطلب غير موجود');
  const transitions = { picked_up: 'at_branch', at_branch: 'washing', washing: 'ready' };
  if (transitions[o.status] !== body.status) throw httpError(400, 'انتقال غير مسموح');
  o.status = body.status;
  if (body.status === 'at_branch') addHistory(o, 'at_branch', `استلم ${o.branchName} الملابس`);
  if (body.status === 'washing') {
    addHistory(o, 'washing', 'بدأ الغسيل المنفرد والكي');
    notifyCustomer(o.customerId, '🧺 بدأنا غسيل ملابسك', `طلبك ${o.id} الآن في مرحلة الغسيل والكي`);
  }
  if (body.status === 'ready') {
    addHistory(o, 'ready', 'الملابس جاهزة ومغلفة بانتظار المندوب');
    notifyCustomer(o.customerId, '✨ ملابسك جاهزة', `طلبك ${o.id} جاهز وسيتم توصيله قريباً`);
    if (o.driverId) notifyDriver(o.driverId, 'طلب جاهز للتوصيل', `${o.id} جاهز في ${o.branchName}`);
  }
  emitOrder(o, 'order_updated');
  save();
  return { order: orderView(o) };
});

/* ------------------------------------------------------------------ */
/* Admin routes                                                        */
/* ------------------------------------------------------------------ */
function adminPaymentView() {
  const p = db.payment.providers;
  return {
    activeProvider: db.payment.activeProvider,
    codEnabled: db.payment.codEnabled,
    providers: {
      moyasar: { publishableKey: p.moyasar.publishableKey, secretKeyMasked: mask(p.moyasar.secretKey), configured: !!p.moyasar.secretKey },
      tap: { publicKey: p.tap.publicKey, secretKeyMasked: mask(p.tap.secretKey), configured: !!p.tap.secretKey },
      paytabs: { profileId: p.paytabs.profileId, region: p.paytabs.region, serverKeyMasked: mask(p.paytabs.serverKey), configured: !!(p.paytabs.profileId && p.paytabs.serverKey) }
    },
    labels: Object.fromEntries(Object.entries(adapters).map(([k, v]) => [k, v.label]))
  };
}
function adminNotifView() {
  const w = db.notifications.whatsapp;
  return { whatsapp: { enabled: w.enabled, phoneNumberId: w.phoneNumberId, templateName: w.templateName, languageCode: w.languageCode, accessTokenMasked: mask(w.accessToken), configured: !!(w.phoneNumberId && w.accessToken) } };
}

route('GET', '/api/admin/bootstrap', ['admin'], () => ({
  settings: { ...db.settings, vapid: undefined },
  payment: adminPaymentView(),
  notifications: adminNotifView(),
  zones: db.zones,
  branches: db.branches.map(publicBranch),
  drivers: db.drivers.map(publicDriver),
  kiloPackages: db.kiloPackages,
  subscriptions: db.subscriptions,
  specialItems: db.specialItems,
  coupons: db.coupons.map((c) => ({ ...c, usedBy: undefined })),
  pushEnabled: !!webpush
}));

route('GET', '/api/admin/orders', ['admin'], ({ query }) => {
  const status = query.get('status');
  const q = (query.get('q') || '').trim();
  let list = db.orders;
  if (status === 'active') list = list.filter((o) => !['delivered', 'cancelled'].includes(o.status));
  else if (status) list = list.filter((o) => o.status === status);
  if (q) list = list.filter((o) => o.id.includes(q) || o.customerPhone.includes(q) || o.customerName.includes(q));
  return { orders: list.slice(0, 300).map(orderView) };
});

route('POST', '/api/admin/orders/:id/assign', ['admin'], ({ params, body }) => {
  const o = findOrder(params.id);
  const d = findDriver(body.driverId);
  if (!o || !d) throw httpError(404, 'الطلب أو المندوب غير موجود');
  if (!['pending_driver', 'unassigned', 'driver_en_route'].includes(o.status)) throw httpError(400, 'لا يمكن إعادة الإسناد في هذه المرحلة');
  const prev = o.driverId;
  o.driverId = d.id;
  o.driverName = d.name;
  o.driverPhone = d.phone;
  o.status = 'pending_driver';
  o.offeredAt = iso();
  o.offerExpiresAt = iso(now() + db.settings.dispatch.offerTimeoutSec * 1000);
  o.triedDriverIds = o.triedDriverIds.filter((x) => x !== d.id);
  addHistory(o, 'pending_driver', `أسندت الإدارة الطلب يدوياً للمندوب ${d.name}`);
  notifyDriver(d.id, '🔔 طلب مسند إليك من الإدارة', `${o.id} - ${o.zoneName}`);
  emitOrder(o, 'order_updated', [prev]);
  save();
  return { order: orderView(o) };
});

route('POST', '/api/admin/orders/:id/cancel', ['admin'], ({ params, body }) => {
  const o = findOrder(params.id);
  if (!o) throw httpError(404, 'الطلب غير موجود');
  if (['delivered', 'cancelled'].includes(o.status)) throw httpError(400, 'الطلب منتهي');
  const prev = o.driverId;
  o.status = 'cancelled';
  releaseOrderResources(o);
  addHistory(o, 'cancelled', 'ألغت الإدارة الطلب: ' + String(body.reason || '').slice(0, 120));
  notifyCustomer(o.customerId, 'تم إلغاء طلبك', `الطلب ${o.id} - ${body.reason || 'تواصل معنا للمزيد'}`);
  emitOrder(o, 'order_updated', [prev]);
  save();
  return { order: orderView(o) };
});

route('GET', '/api/admin/customers', ['admin'], () => ({
  customers: db.customers.map((c) => ({ ...publicCustomer(c), createdAt: c.createdAt, orders: db.orders.filter((o) => o.customerId === c.id).length }))
}));

route('GET', '/api/admin/reports', ['admin'], ({ query }) => {
  const range = query.get('range') || '30d';
  const days = { today: 1, '7d': 7, '30d': 30, all: 36500 }[range] || 30;
  const since = range === 'today' ? new Date().setHours(0, 0, 0, 0) : now() - days * 86400000;
  const orders = db.orders.filter((o) => new Date(o.createdAt).getTime() >= since);
  const paidOrders = orders.filter((o) => o.paymentStatus === 'paid' && o.status !== 'cancelled');
  const orderRevenue = paidOrders.reduce((s, o) => s + o.pricing.total + (o.extraPaymentStatus === 'paid' ? o.pricing.extraCost : 0), 0);
  const subPayments = db.payments.filter((p) => p.purpose === 'subscription' && p.status === 'paid' && new Date(p.createdAt).getTime() >= since);
  const subRevenue = subPayments.reduce((s, p) => s + p.amount, 0);
  const revenue = round2(orderRevenue + subRevenue);

  const byStatus = {};
  orders.forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });

  const byBranch = db.branches.map((b) => {
    const bo = orders.filter((o) => o.branchId === b.id);
    const rev = bo.filter((o) => o.paymentStatus === 'paid' && o.status !== 'cancelled').reduce((s, o) => s + o.pricing.total + (o.extraPaymentStatus === 'paid' ? o.pricing.extraCost : 0), 0);
    return { id: b.id, name: b.name, city: b.city, orders: bo.length, delivered: bo.filter((o) => o.status === 'delivered').length, revenue: round2(rev), kilos: round2(bo.reduce((s, o) => s + (o.actualKilos || 0), 0)) };
  });

  const drivers = db.drivers.map((d) => {
    const assigned = orders.filter((o) => o.driverId === d.id);
    const accepted = assigned.filter((o) => o.acceptedAt && o.offeredAt);
    const avgAccept = accepted.length ? accepted.reduce((s, o) => s + (new Date(o.acceptedAt) - new Date(o.offeredAt)) / 1000, 0) / accepted.length : 0;
    const rated = assigned.filter((o) => o.rating);
    return {
      id: d.id,
      name: d.name,
      city: d.city,
      onDuty: d.onDuty,
      assigned: assigned.length,
      delivered: assigned.filter((o) => o.status === 'delivered').length,
      rejections: orders.reduce((s, o) => s + o.rejections.filter((r) => r.driverId === d.id).length, 0),
      timeouts: orders.reduce((s, o) => s + o.timeouts.filter((t) => t.driverId === d.id).length, 0),
      avgAcceptSec: Math.round(avgAccept),
      avgRating: rated.length ? round2(rated.reduce((s, o) => s + o.rating.driver, 0) / rated.length) : null,
      collected: round2(assigned.reduce((s, o) => s + (o.collectedByDriver || 0), 0))
    };
  });

  const rated = orders.filter((o) => o.rating);
  const activeSubs = db.customers.filter((c) => c.subscription && c.subscription.active);
  const expiringSoon = activeSubs.filter((c) => new Date(c.subscription.expiresAt).getTime() - now() < 3 * 86400000);

  return {
    range,
    totals: {
      orders: orders.length,
      delivered: byStatus.delivered || 0,
      cancelled: byStatus.cancelled || 0,
      revenue,
      orderRevenue: round2(orderRevenue),
      subRevenue: round2(subRevenue),
      vat: vatOf(revenue),
      avgOrderValue: paidOrders.length ? round2(orderRevenue / paidOrders.length) : 0,
      kilos: round2(orders.reduce((s, o) => s + (o.actualKilos || 0), 0)),
      newCustomers: db.customers.filter((c) => new Date(c.createdAt).getTime() >= since).length
    },
    byStatus,
    byBranch,
    drivers,
    ratings: { count: rated.length, avgService: rated.length ? round2(rated.reduce((s, o) => s + o.rating.service, 0) / rated.length) : null, latest: rated.slice(0, 10).map((o) => ({ id: o.id, customerName: o.customerName, driverName: o.driverName, ...o.rating })) },
    subscriptions: { active: activeSubs.length, expiringSoon: expiringSoon.length, sold: subPayments.length },
    coupons: db.coupons.map((c) => ({ code: c.code, usedCount: c.usedCount, active: c.active }))
  };
});

route('PUT', '/api/admin/settings', ['admin'], ({ body }) => {
  const s = db.settings;
  if (body.brandName !== undefined) s.brandName = String(body.brandName).slice(0, 60);
  if (body.vatNumber !== undefined) s.vatNumber = String(body.vatNumber).replace(/[^\d]/g, '').slice(0, 15);
  if (body.vatRate !== undefined) s.vatRate = Math.max(0, Math.min(0.5, Number(body.vatRate) || 0));
  if (body.extraKiloPrice !== undefined) s.extraKiloPrice = Math.max(0, Number(body.extraKiloPrice) || 0);
  if (body.publicBaseUrl !== undefined) s.publicBaseUrl = String(body.publicBaseUrl).trim();
  if (body.demoMode !== undefined) s.demoMode = !!body.demoMode;
  if (body.requireScalePhoto !== undefined) s.requireScalePhoto = !!body.requireScalePhoto;
  if (body.offerTimeoutSec !== undefined) s.dispatch.offerTimeoutSec = Math.max(30, Math.min(3600, parseInt(body.offerTimeoutSec, 10) || 300));
  if (body.referral) {
    s.referral.enabled = !!body.referral.enabled;
    s.referral.rewardReferrer = Math.max(0, Number(body.referral.rewardReferrer) || 0);
    s.referral.rewardNewCustomer = Math.max(0, Number(body.referral.rewardNewCustomer) || 0);
  }
  if (body.subscriptionAlerts) {
    s.subscriptionAlerts.lowBalancePercent = Math.max(1, Math.min(90, Number(body.subscriptionAlerts.lowBalancePercent) || 20));
    s.subscriptionAlerts.expiryDaysBefore = Math.max(1, Math.min(15, Number(body.subscriptionAlerts.expiryDaysBefore) || 3));
  }
  save();
  return { settings: { ...s, vapid: undefined } };
});

route('PUT', '/api/admin/payment', ['admin'], ({ body }) => {
  if (body.activeProvider !== undefined) {
    if (!adapters[body.activeProvider]) throw httpError(400, 'بوابة غير معروفة');
    db.payment.activeProvider = body.activeProvider;
  }
  if (body.codEnabled !== undefined) db.payment.codEnabled = !!body.codEnabled;
  const p = db.payment.providers;
  const keep = (v) => v === undefined || v === null || String(v).includes('••••');
  const b = body.providers || {};
  if (b.moyasar) {
    if (b.moyasar.publishableKey !== undefined) p.moyasar.publishableKey = String(b.moyasar.publishableKey).trim();
    if (!keep(b.moyasar.secretKey)) p.moyasar.secretKey = String(b.moyasar.secretKey).trim();
  }
  if (b.tap) {
    if (b.tap.publicKey !== undefined) p.tap.publicKey = String(b.tap.publicKey).trim();
    if (!keep(b.tap.secretKey)) p.tap.secretKey = String(b.tap.secretKey).trim();
  }
  if (b.paytabs) {
    if (b.paytabs.profileId !== undefined) p.paytabs.profileId = String(b.paytabs.profileId).trim();
    if (b.paytabs.region !== undefined && PAYTABS_HOSTS[b.paytabs.region]) p.paytabs.region = b.paytabs.region;
    if (!keep(b.paytabs.serverKey)) p.paytabs.serverKey = String(b.paytabs.serverKey).trim();
  }
  save();
  return { payment: adminPaymentView() };
});

route('POST', '/api/admin/payment/test', ['admin'], async ({ body }) => {
  const a = adapters[body.provider];
  if (!a) throw httpError(400, 'بوابة غير معروفة');
  try {
    return await a.test();
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

route('PUT', '/api/admin/notifications', ['admin'], ({ body }) => {
  const w = db.notifications.whatsapp;
  const b = body.whatsapp || {};
  if (b.enabled !== undefined) w.enabled = !!b.enabled;
  if (b.phoneNumberId !== undefined) w.phoneNumberId = String(b.phoneNumberId).trim();
  if (b.templateName !== undefined) w.templateName = String(b.templateName).trim();
  if (b.languageCode !== undefined) w.languageCode = String(b.languageCode).trim() || 'ar';
  if (b.accessToken !== undefined && !String(b.accessToken).includes('••••')) w.accessToken = String(b.accessToken).trim();
  save();
  return { notifications: adminNotifView() };
});

route('POST', '/api/admin/notifications/test', ['admin'], async ({ body }) => {
  const phone = normalizePhone(body.phone);
  const entry = await sendWhatsApp(phone, 'رسالة تجريبية من نظام مغاسل سحابة');
  return { entry };
});

route('GET', '/api/admin/outbox', ['admin'], () => ({ outbox: db.outbox.slice(0, 100) }));

route('POST', '/api/admin/drivers', ['admin'], ({ body }) => {
  const phone = normalizePhone(body.phone);
  if (db.drivers.some((d) => d.phone === phone)) throw httpError(400, 'رقم الجوال مستخدم لمندوب آخر');
  const zone = findZone(body.zoneId);
  if (!zone) throw httpError(400, 'اختر منطقة');
  if (!/^\d{4,6}$/.test(String(body.pin || ''))) throw httpError(400, 'الرمز السري يجب أن يكون 4-6 أرقام');
  const d = { id: uid('DRV-'), name: String(body.name || '').trim().slice(0, 60) || 'مندوب', phone, city: zone.city, zoneId: zone.id, backupZoneIds: (body.backupZoneIds || []).filter(findZone), pinHash: hashSecret(body.pin), active: true, onDuty: false, location: null };
  db.drivers.push(d);
  save();
  return { driver: publicDriver(d) };
});

route('PUT', '/api/admin/drivers/:id', ['admin'], ({ params, body }) => {
  const d = findDriver(params.id);
  if (!d) throw httpError(404, 'المندوب غير موجود');
  if (body.name) d.name = String(body.name).trim().slice(0, 60);
  if (body.phone) {
    const phone = normalizePhone(body.phone);
    if (db.drivers.some((x) => x.phone === phone && x.id !== d.id)) throw httpError(400, 'رقم الجوال مستخدم');
    d.phone = phone;
  }
  if (body.zoneId) {
    const z = findZone(body.zoneId);
    if (!z) throw httpError(400, 'منطقة غير صحيحة');
    d.zoneId = z.id;
    d.city = z.city;
  }
  if (Array.isArray(body.backupZoneIds)) d.backupZoneIds = body.backupZoneIds.filter(findZone);
  if (body.active !== undefined) d.active = !!body.active;
  if (body.pin) {
    if (!/^\d{4,6}$/.test(String(body.pin))) throw httpError(400, 'الرمز السري يجب أن يكون 4-6 أرقام');
    d.pinHash = hashSecret(body.pin);
    Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].role === 'driver' && db.sessions[t].userId === d.id) delete db.sessions[t]; });
  }
  save();
  return { driver: publicDriver(d) };
});

route('POST', '/api/admin/branches', ['admin'], ({ body }) => {
  const username = String(body.username || '').trim();
  if (!/^[a-z0-9_.-]{3,30}$/i.test(username)) throw httpError(400, 'اسم المستخدم: 3-30 حرف إنجليزي أو رقم');
  if (db.branches.some((b) => b.username === username)) throw httpError(400, 'اسم المستخدم مستخدم');
  if (String(body.password || '').length < 6) throw httpError(400, 'كلمة المرور 6 أحرف على الأقل');
  const b = { id: uid('BR-'), name: String(body.name || '').trim().slice(0, 80), city: body.city === 'الخبر' ? 'الخبر' : 'الدمام', username, passwordHash: hashSecret(body.password), active: true };
  db.branches.push(b);
  save();
  return { branch: publicBranch(b) };
});

route('PUT', '/api/admin/branches/:id', ['admin'], ({ params, body }) => {
  const b = findBranch(params.id);
  if (!b) throw httpError(404, 'الفرع غير موجود');
  if (body.name) b.name = String(body.name).trim().slice(0, 80);
  if (body.active !== undefined) b.active = !!body.active;
  if (body.password) {
    if (String(body.password).length < 6) throw httpError(400, 'كلمة المرور 6 أحرف على الأقل');
    b.passwordHash = hashSecret(body.password);
  }
  save();
  return { branch: publicBranch(b) };
});

route('POST', '/api/admin/zones', ['admin'], ({ body }) => {
  const b = findBranch(body.branchId);
  if (!b) throw httpError(400, 'اختر الفرع');
  const z = { id: uid('Z-'), city: b.city, name: String(body.name || '').trim().slice(0, 80), branchId: b.id, lat: Number(body.lat) || 26.42, lng: Number(body.lng) || 50.08, active: true };
  db.zones.push(z);
  save();
  return { zone: z };
});

route('PUT', '/api/admin/zones/:id', ['admin'], ({ params, body }) => {
  const z = findZone(params.id);
  if (!z) throw httpError(404, 'المنطقة غير موجودة');
  if (body.name) z.name = String(body.name).trim().slice(0, 80);
  if (body.branchId) {
    const b = findBranch(body.branchId);
    if (!b) throw httpError(400, 'فرع غير صحيح');
    z.branchId = b.id;
    z.city = b.city;
  }
  if (Number.isFinite(Number(body.lat)) && body.lat !== '') z.lat = Number(body.lat);
  if (Number.isFinite(Number(body.lng)) && body.lng !== '') z.lng = Number(body.lng);
  if (body.active !== undefined) z.active = !!body.active;
  save();
  return { zone: z };
});

const CATALOGS = ['kiloPackages', 'subscriptions', 'specialItems'];
route('PUT', '/api/admin/catalog/:collection/:id', ['admin'], ({ params, body }) => {
  if (!CATALOGS.includes(params.collection)) throw httpError(400, 'قسم غير معروف');
  const item = db[params.collection].find((x) => x.id === params.id);
  if (!item) throw httpError(404, 'العنصر غير موجود');
  if (body.name) item.name = String(body.name).slice(0, 80);
  if (body.price !== undefined) item.price = Math.max(0, Number(body.price) || 0);
  if (body.oldPrice !== undefined) item.oldPrice = Math.max(0, Number(body.oldPrice) || 0);
  if (body.kilos !== undefined && params.collection !== 'specialItems') item.kilos = Math.max(1, Number(body.kilos) || 1);
  if (body.active !== undefined) item.active = !!body.active;
  save();
  return { item };
});

route('POST', '/api/admin/catalog/:collection', ['admin'], ({ params, body }) => {
  if (!CATALOGS.includes(params.collection)) throw httpError(400, 'قسم غير معروف');
  const base = { id: uid(params.collection === 'subscriptions' ? 'SUB-' : params.collection === 'kiloPackages' ? 'PKG-' : 'SPC-'), name: String(body.name || 'عنصر جديد').slice(0, 80), price: Math.max(0, Number(body.price) || 0), oldPrice: Math.max(0, Number(body.oldPrice) || 0), active: true };
  let item;
  if (params.collection === 'kiloPackages') item = { ...base, kilos: Math.max(1, Number(body.kilos) || 5), service: body.service === 'wash_fold' ? 'wash_fold' : 'wash_iron', serviceType: body.service === 'wash_fold' ? 'غسيل وطي' : 'غسيل وكي', approxPieces: '', icon: 'fa-shirt', badge: '' };
  else if (params.collection === 'subscriptions') item = { ...base, kilos: Math.max(1, Number(body.kilos) || 25), validityDays: 30, badge: '', perks: [`${Number(body.kilos) || 25} كيلو غسيل وكي طوال الشهر`, 'استلام وتوصيل مجاني'] };
  else item = { ...base, category: String(body.category || 'خدمات خاصة').slice(0, 40), unit: String(body.unit || 'قطعة').slice(0, 20), icon: 'fa-star', description: String(body.description || '').slice(0, 120) };
  db[params.collection].push(item);
  save();
  return { item };
});

route('POST', '/api/admin/coupons', ['admin'], ({ body }) => {
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(code)) throw httpError(400, 'الكود: 3-20 حرف إنجليزي أو رقم');
  if (db.coupons.some((c) => c.code === code)) throw httpError(400, 'الكود موجود مسبقاً');
  const c = { id: uid('CPN-'), code, type: body.type === 'fixed' ? 'fixed' : 'percent', value: Math.max(0, Number(body.value) || 0), minTotal: Math.max(0, Number(body.minTotal) || 0), maxUses: Math.max(0, parseInt(body.maxUses, 10) || 0), usedCount: 0, onePerCustomer: body.onePerCustomer !== false, usedBy: [], expiresAt: body.expiresAt || '', active: true };
  if (c.type === 'percent' && c.value > 100) throw httpError(400, 'النسبة لا تتجاوز 100%');
  db.coupons.push(c);
  save();
  return { coupon: { ...c, usedBy: undefined } };
});

route('PUT', '/api/admin/coupons/:id', ['admin'], ({ params, body }) => {
  const c = db.coupons.find((x) => x.id === params.id);
  if (!c) throw httpError(404, 'الكوبون غير موجود');
  if (body.active !== undefined) c.active = !!body.active;
  if (body.value !== undefined) c.value = Math.max(0, Number(body.value) || 0);
  if (body.minTotal !== undefined) c.minTotal = Math.max(0, Number(body.minTotal) || 0);
  if (body.maxUses !== undefined) c.maxUses = Math.max(0, parseInt(body.maxUses, 10) || 0);
  if (body.expiresAt !== undefined) c.expiresAt = body.expiresAt;
  save();
  return { coupon: { ...c, usedBy: undefined } };
});

route('POST', '/api/admin/password', ['admin'], ({ session, body }) => {
  const a = db.admins.find((x) => x.id === session.userId);
  if (!verifySecret(body.current, a.passwordHash)) throw httpError(400, 'كلمة المرور الحالية غير صحيحة');
  if (String(body.next || '').length < 8) throw httpError(400, 'كلمة المرور الجديدة 8 أحرف على الأقل');
  a.passwordHash = hashSecret(body.next);
  save();
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* Background jobs                                                     */
/* ------------------------------------------------------------------ */
setInterval(() => {
  const t = now();
  db.orders
    .filter((o) => o.status === 'pending_driver' && o.offerExpiresAt && new Date(o.offerExpiresAt).getTime() < t)
    .forEach((o) => {
      o.timeouts.push({ driverId: o.driverId, at: iso() });
      o.triedDriverIds.push(o.driverId);
      addHistory(o, 'pending_driver', `انتهت مهلة القبول للمندوب ${o.driverName}`);
      notifyDriver(o.driverId, 'انتهت مهلة الطلب', `تم تحويل الطلب ${o.id} لمندوب آخر`);
      dispatchOrder(o, 'تحويل تلقائي');
    });
}, 10000);

setInterval(() => {
  db.customers.forEach(checkSubscriptionAlerts);
  const t = now();
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].exp < t) delete db.sessions[k]; });
  save();
}, 60000);

let reconciling = false;
setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const dayAgo = now() - 86400000;
    const pending = db.payments.filter((p) => p.status === 'pending' && p.provider !== 'sandbox' && new Date(p.createdAt).getTime() > dayAgo);
    for (const p of pending) {
      try { applyPaymentResult(p, await adapters[p.provider].verify(p)); } catch (e) { /* retry next round */ }
    }
  } finally {
    reconciling = false;
  }
}, 120000);

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveFile(res, filePath, extraHeaders = {}) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      ...extraHeaders
    };
    res.writeHead(200, headers);
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  /* SSE */
  if (pathname === '/api/events' && req.method === 'GET') {
    const s = getSession(req, url.searchParams);
    if (!s) return sendJSON(res, 401, { error: 'غير مصرح' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    const client = { res, role: s.role, userId: s.userId };
    sseClients.push(client);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients = sseClients.filter((c) => c !== client);
    });
    return;
  }

  /* Payment return from gateway (GET or POST for PayTabs) */
  if (pathname === '/pay/return') {
    const pid = url.searchParams.get('pid');
    const p = db.payments.find((x) => x.id === pid);
    if (!p) return redirect(res, '/?pay=unknown');
    try {
      if (p.status === 'pending') applyPaymentResult(p, await adapters[p.provider].verify(p));
    } catch (e) { /* will reconcile later */ }
    const target = p.purpose === 'subscription' ? '/#wallet' : '/#orders';
    return redirect(res, `/?pay=${p.status}&pid=${p.id}${target}`);
  }

  /* API */
  if (pathname.startsWith('/api/')) {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) return sendJSON(res, 404, { error: 'المسار غير موجود' });
    try {
      const session = getSession(req, url.searchParams);
      if (r.roles && (!session || !r.roles.includes(session.role))) throw httpError(401, 'يرجى تسجيل الدخول');
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const params = r.re.exec(pathname).groups || {};
      const result = await r.handler({ req, res, body, params, query: url.searchParams, session });
      return sendJSON(res, 200, result);
    } catch (e) {
      if (!e.status) console.error(e);
      return sendJSON(res, e.status || 500, { error: e.status ? e.message : 'حدث خطأ غير متوقع' });
    }
  }

  /* Uploaded scale photos */
  if (pathname.startsWith('/uploads/')) {
    const name = path.basename(pathname);
    return serveFile(res, path.join(UPLOAD_DIR, name), { 'Cache-Control': 'private, max-age=86400' });
  }

  /* Static */
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
  else if (['/driver', '/branch', '/admin'].includes(pathname)) return redirect(res, pathname + '/');
  const extra = pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {};
  return serveFile(res, filePath, extra);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Shaaba Laundry System running at http://localhost:${PORT}`);
  console.log(`Push notifications: ${webpush ? 'enabled' : 'disabled (web-push not installed)'}`);
});
