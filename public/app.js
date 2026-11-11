const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = amount => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount || 0);
const state = {
  products: [],
  categories: [],
  cart: JSON.parse(localStorage.getItem("nexventa-cart") || "[]"),
  voucherCart: JSON.parse(localStorage.getItem("nexventa-voucher-cart") || "[]"),
  user: null,
  admin: false,
  activeCategory: "All",
  coupon: "",
  discount: 0,
  adminData: null,
  activeTab: "products",
  page: "home",
  couponOffers: [],
  couponOffersLoaded: false,
  ownedVouchers: [],
  pendingVerificationEmail: ""
};
let toastTimer;

function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3400);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showOverlay(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.hidden = false;
  document.body.classList.add("modal-open");
  const focusable = overlay.querySelector("input,button,select,textarea");
  if (focusable) setTimeout(() => focusable.focus(), 60);
}

function hideOverlay(overlay) {
  if (overlay.id === "admin-overlay" && state.admin) {
    void logout();
    return;
  }
  overlay.hidden = true;
  if (!$(".overlay:not([hidden])")) document.body.classList.remove("modal-open");
}

function attachOverlayDismiss() {
  $$(".overlay").forEach(overlay => {
    overlay.addEventListener("click", event => {
      if (event.target === overlay) hideOverlay(overlay);
    });
    $$(".modal-close,.close-overlay", overlay).forEach(button => button.addEventListener("click", () => hideOverlay(overlay)));
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      const visible = [...$$(".overlay")].reverse().find(overlay => !overlay.hidden);
      if (visible) hideOverlay(visible);
    }
  });
}

async function loadStore() {
  const store = await api("/api/store");
  state.products = store.products;
  state.categories = store.categories;
  renderCategories();
  renderFilters();
  renderProducts();
  renderCart();
}

function configurePage() {
  const page = {
    "/": "home",
    "/games": "games",
    "/shop": "shop",
    "/coupons": "coupons",
    "/reviews": "reviews"
  }[location.pathname] || "home";
  state.page = page;
  $$("[data-page]").forEach(section => {
    section.hidden = section.dataset.page !== page;
  });
  $$(".nav-link").forEach(link => {
    const active = new URL(link.href).pathname === location.pathname;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const titles = {
    home: "Nexventa — Digital goods for gamers",
    games: "Games — Nexventa",
    shop: "Shop — Nexventa",
    coupons: "Discount vouchers — Nexventa",
    reviews: "Player reviews — Nexventa"
  };
  document.title = titles[page];
  if (page === "shop") {
    state.activeCategory = new URLSearchParams(location.search).get("category") || "All";
  }
}

async function loadIdentity() {
  const me = await api("/api/me");
  state.user = me.user;
  state.admin = me.admin;
  document.body.classList.toggle("is-admin", state.admin);
  $("#account-button").textContent = state.user ? "My account" : "Sign in";
  renderOwnedVouchers();
}

function renderCategories() {
  const grid = $("#category-grid");
  const glyphs = ["✳", "◈", "⌘", "✦", "◇"];
  grid.innerHTML = state.categories.map((category, index) => `
    <button class="category-card" data-category="${escapeHtml(category.name)}" aria-label="Browse ${escapeHtml(category.name)}">
      <span class="category-art" aria-hidden="true">${glyphs[index % glyphs.length]}</span>
      <span class="category-copy"><small>${escapeHtml(category.game || "Game collection")}</small><strong>${escapeHtml(category.name)}</strong></span>
      <span class="category-arrow">↗</span>
    </button>
  `).join("");
  $$(".category-card", grid).forEach(card => card.addEventListener("click", () => {
    location.assign(`/shop?category=${encodeURIComponent(card.dataset.category)}`);
  }));
}

function renderFilters() {
  const names = ["All", ...state.categories.map(category => category.name)];
  $("#filter-chips").innerHTML = names.map(name => `
    <button class="filter-chip ${state.activeCategory === name ? "active" : ""}" data-filter="${escapeHtml(name)}">${escapeHtml(name)}</button>
  `).join("");
  $$(".filter-chip").forEach(button => button.addEventListener("click", () => selectCategory(button.dataset.filter)));
}

function selectCategory(category) {
  state.activeCategory = category;
  renderFilters();
  renderProducts();
}

function renderProducts() {
  const query = $("#search-input").value.trim().toLowerCase();
  let products = state.products.filter(product => {
    const categoryMatches = state.activeCategory === "All" || product.category === state.activeCategory || product.game === state.activeCategory;
    const queryMatches = !query || `${product.name} ${product.description} ${product.game} ${product.category}`.toLowerCase().includes(query);
    return categoryMatches && queryMatches;
  });
  const sort = $("#sort-select").value;
  if (sort === "price-low") products.sort((a, b) => a.price_cents - b.price_cents);
  if (sort === "price-high") products.sort((a, b) => b.price_cents - a.price_cents);
  $("#product-count").textContent = `${products.length} ${products.length === 1 ? "drop" : "drops"}`;
  $("#empty-state").hidden = products.length > 0;
  $("#product-grid").innerHTML = products.map((product, index) => `
    <article class="product-card" style="animation-delay:${Math.min(index * 45, 270)}ms">
      <div class="product-art">
        ${product.imageUrl ? `<img src="${product.imageUrl}" alt="" loading="lazy">` : `<span class="product-symbol" aria-hidden="true">${["✳", "◈", "⌘", "✦", "◇"][index % 5]}</span>`}
        <span class="product-tag">${escapeHtml(product.game || product.category || "Digital drop")}</span>
        <button class="product-edit" data-edit="${product.id}" aria-label="Edit ${escapeHtml(product.name)}">✎</button>
      </div>
      <div class="product-info">
        <div class="product-meta"><span>${product.featured ? "✦ Community favorite" : "Digital download"}</span><span>INSTANT</span></div>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="product-description">${escapeHtml(product.description || "A little something extra for your next session.")}</p>
        <div class="product-footer"><strong class="price">${money(product.price)}</strong><button class="add-to-cart" data-add="${product.id}" aria-label="Add ${escapeHtml(product.name)} to bag">+</button></div>
      </div>
    </article>
  `).join("");
  $$("[data-add]", $("#product-grid")).forEach(button => button.addEventListener("click", () => addToCart(Number(button.dataset.add))));
  $$("[data-edit]", $("#product-grid")).forEach(button => button.addEventListener("click", () => openProductEditor(Number(button.dataset.edit))));
}

async function loadCouponOffers() {
  const data = await api("/api/coupon-offers");
  state.couponOffers = data.offers;
  state.couponOffersLoaded = true;
  state.ownedVouchers = data.vouchers;
  renderCart();
  $("#voucher-grid").innerHTML = data.offers.map(offer => `
    <article class="voucher-card">
      <div class="voucher-discount">${offer.discount_percent}<span>% OFF</span></div>
      <div class="voucher-info"><span class="product-tag">ONE-TIME VOUCHER</span><h3>${escapeHtml(offer.name)}</h3><p>${escapeHtml(offer.description || "A private discount code for your next product order.")}</p><div class="voucher-actions"><strong>${money(offer.price_cents / 100)}</strong><button class="button button-primary" data-voucher-add="${offer.id}">Buy voucher <span>+</span></button></div></div>
    </article>
  `).join("");
  $("#voucher-empty").hidden = data.offers.length > 0;
  $$("[data-voucher-add]").forEach(button => button.addEventListener("click", () => addVoucherToCart(Number(button.dataset.voucherAdd))));
  renderOwnedVouchers();
}

function renderOwnedVouchers() {
  const container = $("#owned-vouchers");
  if (!container) return;
  if (!state.user) {
    container.innerHTML = `<p class="page-description">Sign in to see vouchers you’ve purchased.</p><button class="button button-quiet" id="voucher-sign-in">Sign in</button>`;
    $("#voucher-sign-in").addEventListener("click", () => toggleAuth("login"));
    return;
  }
  container.innerHTML = state.ownedVouchers.length ? state.ownedVouchers.map(voucher => `
    <div class="owned-voucher"><div><strong>${voucher.discount_percent}% off</strong><small>${voucher.used_at ? "Already redeemed" : "Ready to use once"}</small></div><code>${escapeHtml(voucher.code)}</code><button class="table-action" data-copy-voucher="${escapeHtml(voucher.code)}" ${voucher.used_at ? "disabled" : ""}>Copy</button></div>
  `).join("") : `<p class="page-description">Your purchased vouchers will appear here.</p>`;
  $$("[data-copy-voucher]", container).forEach(button => button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copyVoucher);
      toast("Voucher code copied.");
    } catch { toast("Copy failed. Select and copy the code manually.", true); }
  }));
}

function openVoucherEditor(id) {
  const offer = id ? state.adminData?.couponOffers.find(item => item.id === id) : null;
  const form = $("#voucher-offer-form");
  form.reset();
  form.elements.id.value = offer?.id || "";
  form.elements.name.value = offer?.name || "";
  form.elements.description.value = offer?.description || "";
  form.elements.price.value = offer ? (offer.price_cents / 100).toFixed(2) : "";
  form.elements.discount.value = offer?.discount_percent || 10;
  $("#voucher-editor-title").innerHTML = offer ? "Edit <span>voucher.</span>" : "Create a <span>voucher.</span>";
  showOverlay("voucher-editor-overlay");
}

async function loadReviews() {
  const data = await api("/api/reviews");
  const average = data.count ? data.average.toFixed(1) : "—";
  $("#review-summary").textContent = data.count
    ? `${average} out of 5 · ${data.count} ${data.count === 1 ? "player review" : "player reviews"}`
    : "No ratings yet";
  $("#review-list").innerHTML = data.reviews.map(review => `
    <article class="review-card"><div class="review-rating" aria-label="${review.rating} out of 5 stars">${"★".repeat(review.rating)}<span>${"★".repeat(5 - review.rating)}</span></div><p>${escapeHtml(review.message)}</p><div class="review-author"><strong>${escapeHtml(review.customer_name)}</strong><time>${new Date(`${review.created_at}Z`).toLocaleDateString()}</time></div></article>
  `).join("");
  $("#review-empty").hidden = data.count > 0;
  $("#review-form-wrap").innerHTML = data.canReview ? `
    <form id="review-form" class="review-form">
      <div><strong>Share your experience</strong><small>${average} / 5 average · ${data.count} ${data.count === 1 ? "review" : "reviews"}</small></div>
      <div class="star-picker" role="radiogroup" aria-label="Rate your experience"><input type="hidden" name="rating" value="5">${[1, 2, 3, 4, 5].map(rating => `<button type="button" class="star-choice ${rating === 5 ? "selected" : ""}" data-rating="${rating}" role="radio" aria-checked="${rating === 5}" aria-label="${rating} stars">★</button>`).join("")}</div>
      <label class="sr-only" for="review-message">Your review</label><textarea id="review-message" name="message" rows="3" maxlength="1000" minlength="5" placeholder="How was your experience?" required></textarea>
      <button class="button button-primary">Post review</button>
    </form>
  ` : `
    <div class="review-login"><div><strong>Purchased from Nexventa?</strong><small>Sign in to leave a rating and review.</small></div><button class="button button-quiet" id="review-sign-in">Sign in</button></div>
  `;
  $("#review-sign-in")?.addEventListener("click", () => toggleAuth("login"));
  const form = $("#review-form");
  if (form) {
    const buttons = $$(".star-choice", form);
    buttons.forEach(button => button.addEventListener("click", () => {
      const rating = Number(button.dataset.rating);
      form.elements.rating.value = String(rating);
      buttons.forEach(star => {
        const selected = Number(star.dataset.rating) <= rating;
        star.classList.toggle("selected", selected);
        star.setAttribute("aria-checked", Number(star.dataset.rating) === rating ? "true" : "false");
      });
    }));
    form.addEventListener("submit", submitReview);
  }
}

async function submitReview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/reviews", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    await loadReviews();
    toast("Thanks for sharing your review.");
  } catch (error) { toast(error.message, true); }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function persistCart() {
  localStorage.setItem("nexventa-cart", JSON.stringify(state.cart));
  localStorage.setItem("nexventa-voucher-cart", JSON.stringify(state.voucherCart));
  renderCart();
}

function addToCart(id) {
  if (!state.cart.includes(id)) state.cart.push(id);
  persistCart();
  toast("Added to your bag.");
}

function addVoucherToCart(id) {
  if (!state.voucherCart.includes(id)) state.voucherCart.push(id);
  persistCart();
  toast("Voucher added to your bag.");
}

function renderCart() {
  const available = state.cart.map(id => state.products.find(product => product.id === id)).filter(Boolean);
  state.cart = available.map(product => product.id);
  const vouchers = state.couponOffersLoaded
    ? state.voucherCart.map(id => state.couponOffers.find(offer => offer.id === id)).filter(Boolean)
    : [];
  if (state.couponOffersLoaded) state.voucherCart = vouchers.map(voucher => voucher.id);
  const items = [...available.map(product => ({ ...product, kind: "product" })), ...vouchers.map(voucher => ({ ...voucher, kind: "voucher" }))];
  $("#cart-count").textContent = String(items.length);
  $("#bag-heading-count").textContent = `(${items.length})`;
  $("#cart-items").innerHTML = items.length ? items.map((item, index) => `
    <div class="cart-item">
      <div class="cart-thumb" aria-hidden="true">${item.kind === "voucher" ? "%" : ["✳", "◈", "⌘", "✦", "◇"][index % 5]}</div>
      <div class="cart-item-info"><strong>${escapeHtml(item.name)}</strong><small>${item.kind === "voucher" ? `${item.discount_percent}% discount voucher` : escapeHtml(item.game || item.category || "Digital download")}</small></div>
      <strong class="cart-item-price">${money(item.price ?? item.price_cents / 100)}</strong>
      <button class="cart-remove" data-remove="${item.id}" data-kind="${item.kind}" aria-label="Remove ${escapeHtml(item.name)}">×</button>
    </div>
  `).join("") : `<div class="cart-empty"><span>✳</span><p>Your next favorite thing<br>is just around the corner.</p></div>`;
  $$("[data-remove]", $("#cart-items")).forEach(button => button.addEventListener("click", () => {
    if (button.dataset.kind === "voucher") state.voucherCart = state.voucherCart.filter(id => id !== Number(button.dataset.remove));
    else state.cart = state.cart.filter(id => id !== Number(button.dataset.remove));
    persistCart();
  }));
  const productSubtotalCents = available.reduce((sum, product) => sum + (product.price_cents ?? Math.round(product.price * 100)), 0);
  const voucherSubtotalCents = vouchers.reduce((sum, voucher) => sum + voucher.price_cents, 0);
  const discountPercent = Math.min(100, Math.max(0, Number(state.discount) || 0));
  const subtotalCents = productSubtotalCents + voucherSubtotalCents;
  const totalCents = Math.round(subtotalCents * (100 - discountPercent) / 100);
  const discountCents = subtotalCents - totalCents;
  $("#cart-subtotal").textContent = money(subtotalCents / 100);
  $("#cart-discount").textContent = discountPercent ? `−${discountPercent}% (−${money(discountCents / 100)})` : "—";
  $("#cart-total").textContent = money(totalCents / 100);
  $("#checkout-button").disabled = items.length === 0;
}

function toggleAuth(mode = "login") {
  const registering = mode === "register";
  state.pendingVerificationEmail = "";
  $("#verification-step").hidden = true;
  $("#auth-form").dataset.mode = mode;
  $("#name-field").hidden = !registering;
  $("#auth-title").innerHTML = registering ? "Join the <span>good stuff.</span>" : "Welcome <span>back.</span>";
  $("#auth-description").textContent = registering ? "Create your account to keep your digital drops in one place." : "Sign in to find your orders and digital downloads.";
  $("#auth-submit").innerHTML = registering ? "Create my account <span>→</span>" : "Sign in <span>→</span>";
  $("#auth-switch").textContent = registering ? "Already have an account? Sign in →" : "New here? Create an account →";
  $("#auth-form-wrap").hidden = false;
  $("#account-content").hidden = true;
  showOverlay("auth-overlay");
}

async function openAccount() {
  if (!state.user) return toggleAuth("login");
  $("#auth-title").innerHTML = `Hey, <span>${escapeHtml(state.user.name.split(" ")[0])}.</span>`;
  $("#auth-description").textContent = "Your account, orders, and downloads.";
  $("#auth-form-wrap").hidden = true;
  $("#account-content").hidden = false;
  $("#account-content").innerHTML = `<p class="modal-description">Loading your order history…</p>`;
  showOverlay("auth-overlay");
  try {
    const [{ orders }, { vouchers }] = await Promise.all([api("/api/orders"), api("/api/coupon-offers")]);
    state.ownedVouchers = vouchers;
    $("#account-content").innerHTML = `
      <div class="admin-toolbar"><h3>Your order history</h3><button class="table-action" id="account-logout">Sign out</button></div>
      ${orders.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>ORDER</th><th>ITEMS</th><th>TOTAL</th><th>STATUS</th><th>DOWNLOAD</th></tr></thead><tbody>${orders.map(order => `<tr><td>#${order.id}</td><td>${escapeHtml(order.items || "Digital goods")}</td><td>${money(order.total_cents / 100)}</td><td>${escapeHtml(order.status)}</td><td>${order.status === "paid" ? `<button class="table-action" data-download="${order.id}">Get link</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="admin-note">No orders yet. Your next favorite thing is waiting in the shop.</div>`}
      ${vouchers.length ? `<div class="owned-vouchers account-vouchers"><h3>Your vouchers</h3>${vouchers.map(voucher => `<div class="owned-voucher"><div><strong>${voucher.discount_percent}% off</strong><small>${voucher.used_at ? "Already redeemed" : "Ready to use once"}</small></div><code>${escapeHtml(voucher.code)}</code></div>`).join("")}</div>` : ""}
      <div class="support-area"><h3>Need a hand?</h3><form id="support-form" class="form-stack"><label>Subject<input name="subject" required maxlength="120" placeholder="How can we help?"></label><label>Message<textarea name="message" rows="3" required minlength="10" maxlength="3000" placeholder="Tell us what happened…"></textarea></label><button class="button button-quiet">Send support request</button></form></div>
    `;
    $("#account-logout").addEventListener("click", logout);
    $$("[data-download]", $("#account-content")).forEach(button => button.addEventListener("click", () => getDownloads(button.dataset.download)));
    $("#support-form").addEventListener("submit", submitSupport);
  } catch (error) {
    $("#account-content").innerHTML = `<p class="admin-note">${escapeHtml(error.message)}</p>`;
  }
}

async function submitSupport(event) {
  event.preventDefault();
  try {
    await api("/api/support", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    event.currentTarget.reset();
    toast("Support request sent. We'll be in touch.");
  } catch (error) { toast(error.message, true); }
}

async function getDownloads(orderId) {
  try {
    const result = await api(`/api/orders/${orderId}/downloads`, { method: "POST", body: "{}" });
    $("#account-content").insertAdjacentHTML("beforeend", `<div class="admin-note download-links"><strong>One-time download links — save the files after opening.</strong><br>${result.downloads.map(item => `<a class="text-link" href="${escapeHtml(item.url)}">${escapeHtml(item.name)} ↗</a>`).join("<br>")}<br><small>Links expire in 7 days and can only be used once.</small></div>`);
  } catch (error) { toast(error.message, true); }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    state.user = null;
    state.admin = false;
    document.body.classList.remove("is-admin");
    $("#account-button").textContent = "Sign in";
    hideOverlay($("#auth-overlay"));
    hideOverlay($("#admin-overlay"));
    toast("Signed out.");
  } catch (error) { toast(error.message, true); }
}

async function submitFile(file, maxBytes) {
  if (!file) return {};
  if (file.size > maxBytes) throw new Error(`"${file.name}" is too large.`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: reader.result });
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

function populateCategoryOptions(selectedId) {
  $("#product-category").innerHTML = `<option value="">No category</option>${state.categories.map(category => `<option value="${category.id}" ${String(category.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}`;
}

function openProductEditor(id) {
  if (!state.admin) return toast("Unlock admin mode to edit products.", true);
  const product = id
    ? state.adminData?.products.find(item => item.id === id) || state.products.find(item => item.id === id)
    : null;
  const form = $("#product-form");
  form.reset();
  populateCategoryOptions(product?.category_id);
  form.elements.id.value = product?.id || "";
  form.elements.name.value = product?.name || "";
  form.elements.description.value = product?.description || "";
  form.elements.game.value = product?.game || "";
  form.elements.price.value = product ? product.price.toFixed(2) : "";
  form.elements.featured.checked = Boolean(product?.featured);
  $("#editor-title").innerHTML = product ? "Edit this <span>drop.</span>" : "Add a <span>drop.</span>";
  showOverlay("editor-overlay");
}

async function readProductForm(form) {
  const image = await submitFile(form.elements.imageFile.files[0], 2 * 1024 * 1024);
  const file = await submitFile(form.elements.digitalFile.files[0], 10 * 1024 * 1024);
  return {
    name: form.elements.name.value.trim(),
    description: form.elements.description.value,
    categoryId: form.elements.categoryId.value || null,
    game: form.elements.game.value.trim(),
    price: form.elements.price.value,
    featured: form.elements.featured.checked,
    imageName: image.name,
    imageData: image.data,
    fileName: file.name,
    fileData: file.data
  };
}

async function loadAdmin(tab = state.activeTab) {
  state.activeTab = tab;
  try {
    state.adminData = await api("/api/admin/overview");
    renderAdmin();
    showOverlay("admin-overlay");
  } catch (error) { toast(error.message, true); }
}

function renderAdmin() {
  const data = state.adminData;
  if (!data) return;
  $("#admin-stats").innerHTML = [
    ["Revenue", money(data.revenue)],
    ["Orders", data.orderCount],
    ["Customers", data.customerCount],
    ["Products", data.products.length]
  ].map(([label, value]) => `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $$(".admin-tab").forEach(button => button.classList.toggle("active", button.dataset.tab === state.activeTab));
  const body = $("#admin-body");
  if (state.activeTab === "products") {
    body.innerHTML = `<div class="admin-toolbar"><h3>Manage products</h3><button class="button button-primary" id="admin-add-product">+ Add product</button></div>
      <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>PRODUCT</th><th>GAME / CATEGORY</th><th>PRICE</th><th>DELIVERY FILE</th><th>ACTIONS</th></tr></thead><tbody>
      ${data.products.map(product => `<tr><td>${escapeHtml(product.name)}<small>${product.active ? "Listed in shop" : "Temporarily unlisted"}</small></td><td>${escapeHtml(product.game || product.category || "—")}</td><td>${money(product.price)}</td><td>${product.file_name ? "Ready" : "Not uploaded"}</td><td><div class="table-actions"><button class="table-action" data-product-edit="${product.id}">Edit</button><button class="table-action" data-product-unlist="${product.id}" data-active="${product.active ? "true" : "false"}">${product.active ? "Unlist" : "Relist"}</button><button class="table-action danger" data-product-delete="${product.id}">Delete</button></div></td></tr>`).join("") || `<tr><td colspan="5">No products yet.</td></tr>`}
      </tbody></table></div>
      <div class="admin-note"><strong>Delivery & payments:</strong> Digital files are protected outside the public uploads path. Configure a Stripe secret key and webhook to accept payments and activate post-purchase downloads.</div>`;
    $("#admin-add-product").addEventListener("click", () => openProductEditor());
    $$("[data-product-edit]", body).forEach(button => button.addEventListener("click", () => openProductEditor(Number(button.dataset.productEdit))));
    $$("[data-product-unlist]", body).forEach(button => button.addEventListener("click", () => setProductListed(button.dataset.productUnlist, button.dataset.active !== "true")));
    $$("[data-product-delete]", body).forEach(button => button.addEventListener("click", () => removeProduct(button.dataset.productDelete)));
  } else if (state.activeTab === "orders") {
    body.innerHTML = `<div class="admin-toolbar"><h3>Orders & refunds</h3></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>AMOUNT</th><th>STATUS</th><th>CREATED</th><th>ACTION</th></tr></thead><tbody>${data.orders.map(order => `<tr><td>#${order.id}</td><td>${escapeHtml(order.customer_name)}<small>${escapeHtml(order.email)}</small></td><td>${money(order.total_cents / 100)}</td><td>${escapeHtml(order.status)}</td><td>${new Date(`${order.created_at}Z`).toLocaleDateString()}</td><td>${order.status === "paid" ? `<button class="table-action danger" data-refund="${order.id}">Refund</button>` : "—"}</td></tr>`).join("") || `<tr><td colspan="6">No orders yet.</td></tr>`}</tbody></table></div>`;
    $$("[data-refund]", body).forEach(button => button.addEventListener("click", () => refundOrder(button.dataset.refund)));
  } else if (state.activeTab === "customers") {
    body.innerHTML = `<div class="admin-toolbar"><h3>Customer accounts</h3></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>NAME</th><th>EMAIL</th><th>JOINED</th></tr></thead><tbody>${data.customers.map(customer => `<tr><td>${escapeHtml(customer.name)}</td><td>${escapeHtml(customer.email)}</td><td>${new Date(`${customer.created_at}Z`).toLocaleDateString()}</td></tr>`).join("") || `<tr><td colspan="3">No customers yet.</td></tr>`}</tbody></table></div>`;
  } else if (state.activeTab === "support") {
    body.innerHTML = `<div class="admin-toolbar"><h3>Customer support inbox</h3></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>TICKET</th><th>CUSTOMER</th><th>SUBJECT / MESSAGE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>${data.tickets.map(ticket => `<tr><td>#${ticket.id}<small>${new Date(`${ticket.created_at}Z`).toLocaleDateString()}</small></td><td>${escapeHtml(ticket.customer_name)}<small>${escapeHtml(ticket.email)}</small></td><td>${escapeHtml(ticket.subject)}<small>${escapeHtml(ticket.message)}</small></td><td>${escapeHtml(ticket.status)}</td><td><select class="ticket-status" data-ticket="${ticket.id}" aria-label="Ticket ${ticket.id} status"><option value="open" ${ticket.status === "open" ? "selected" : ""}>Open</option><option value="in_progress" ${ticket.status === "in_progress" ? "selected" : ""}>In progress</option><option value="resolved" ${ticket.status === "resolved" ? "selected" : ""}>Resolved</option></select></td></tr>`).join("") || `<tr><td colspan="5">No support requests yet.</td></tr>`}</tbody></table></div><div class="admin-note">Reply directly to the customer at their account email. Update the ticket status here.</div>`;
    $$(".ticket-status", body).forEach(select => select.addEventListener("change", async () => {
      try {
        await api(`/api/admin/tickets/${select.dataset.ticket}`, { method: "PUT", body: JSON.stringify({ status: select.value }) });
        state.adminData.tickets = await api("/api/admin/tickets").then(result => result.tickets);
        toast("Support ticket updated.");
      } catch (error) { toast(error.message, true); }
    }));
  } else if (state.activeTab === "coupons") {
    body.innerHTML = `
      <div class="admin-toolbar"><h3>Vouchers customers can buy</h3><button class="button button-primary" id="admin-add-voucher">+ Add voucher</button></div>
      <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>VOUCHER</th><th>PRICE</th><th>DISCOUNT</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>${data.couponOffers.map(offer => `<tr><td>${escapeHtml(offer.name)}<small>${escapeHtml(offer.description)}</small></td><td>${money(offer.price_cents / 100)}</td><td>${offer.discount_percent}%</td><td>${offer.active ? "Active" : "Inactive"}</td><td><div class="table-actions"><button class="table-action" data-voucher-edit="${offer.id}">Edit</button><button class="table-action" data-voucher-toggle="${offer.id}" data-active="${offer.active ? "true" : "false"}">${offer.active ? "Disable" : "Enable"}</button></div></td></tr>`).join("") || `<tr><td colspan="5">No paid vouchers yet.</td></tr>`}</tbody></table></div>
      <div class="admin-toolbar admin-promo-toolbar"><h3>Free promotional codes</h3><button class="button button-quiet" id="admin-add-coupon">+ Add promo code</button></div>
      <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>CODE</th><th>DISCOUNT</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>${data.coupons.map(coupon => `<tr><td>${escapeHtml(coupon.code)}</td><td>${coupon.discount_percent}% off</td><td>${coupon.active ? "Active" : "Inactive"}</td><td><button class="table-action" data-coupon-toggle="${coupon.id}" data-active="${coupon.active ? "true" : "false"}">${coupon.active ? "Deactivate" : "Activate"}</button></td></tr>`).join("") || `<tr><td colspan="4">No free promo codes.</td></tr>`}</tbody></table></div>
      <div class="admin-note">Paid voucher codes are generated privately after a successful payment. Codes belong to the buyer and can be redeemed once.</div>`;
    $("#admin-add-coupon").addEventListener("click", () => showOverlay("coupon-overlay"));
    $("#admin-add-voucher").addEventListener("click", () => openVoucherEditor());
    $$("[data-voucher-edit]", body).forEach(button => button.addEventListener("click", () => openVoucherEditor(Number(button.dataset.voucherEdit))));
    $$("[data-voucher-toggle]", body).forEach(button => button.addEventListener("click", () => toggleVoucherOffer(button.dataset.voucherToggle, button.dataset.active !== "true")));
    $$("[data-coupon-toggle]", body).forEach(button => button.addEventListener("click", () => toggleCoupon(button.dataset.couponToggle, button.dataset.active !== "true")));
  } else if (state.activeTab === "reviews") {
    body.innerHTML = `<div class="admin-toolbar"><h3>Customer reviews</h3></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>RATING</th><th>CUSTOMER</th><th>REVIEW</th><th>ACTION</th></tr></thead><tbody>${data.reviews.map(review => `<tr><td>${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}</td><td>${escapeHtml(review.customer_name)}</td><td>${escapeHtml(review.message)}</td><td><button class="table-action danger" data-review-delete="${review.id}">Delete</button></td></tr>`).join("") || `<tr><td colspan="4">No reviews yet.</td></tr>`}</tbody></table></div>`;
    $$("[data-review-delete]", body).forEach(button => button.addEventListener("click", () => deleteReview(button.dataset.reviewDelete)));
  } else {
    body.innerHTML = `<div class="admin-toolbar"><h3>Games & categories</h3><button class="button button-primary" id="admin-add-category">+ Add category</button></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>CATEGORY</th><th>GAME / SECTION</th><th>PRODUCTS</th></tr></thead><tbody>${data.categories.map(category => `<tr><td>${escapeHtml(category.name)}</td><td>${escapeHtml(category.game || "—")}</td><td>${data.products.filter(product => product.category_id === category.id).length}</td></tr>`).join("") || `<tr><td colspan="3">No categories yet.</td></tr>`}</tbody></table></div><div class="admin-note">Add a game or category, then assign it to products in the product editor. New sections appear on the storefront automatically.</div>`;
    $("#admin-add-category").addEventListener("click", () => showOverlay("category-overlay"));
  }
}

async function removeProduct(id) {
  if (!confirm("Delete this product? If it has past orders, it will be archived to preserve their records.")) return;
  try {
    const result = await api(`/api/admin/products/${id}`, { method: "DELETE" });
    await loadStore();
    state.adminData = await api("/api/admin/overview");
    renderAdmin();
    toast(result.archived ? "Product removed from the store; past orders were preserved." : "Product permanently deleted.");
  } catch (error) { toast(error.message, true); }
}

async function toggleVoucherOffer(id, active) {
  try {
    await api(`/api/admin/coupon-offers/${id}`, { method: "PUT", body: JSON.stringify({ active }) });
    await loadAdmin("coupons");
    await loadCouponOffers();
    toast(active ? "Voucher enabled." : "Voucher disabled.");
  } catch (error) { toast(error.message, true); }
}

async function deleteReview(id) {
  if (!confirm("Delete this customer review?")) return;
  try {
    await api(`/api/admin/reviews/${id}`, { method: "DELETE" });
    state.adminData.reviews = state.adminData.reviews.filter(review => review.id !== Number(id));
    renderAdmin();
    await loadReviews();
    toast("Review deleted.");
  } catch (error) { toast(error.message, true); }
}

async function setProductListed(id, listed) {
  try {
    await api(`/api/admin/products/${id}/${listed ? "restore" : "unlist"}`, { method: "POST", body: "{}" });
    await loadStore();
    await loadAdmin("products");
    toast(listed ? "Product listed in the shop." : "Product temporarily unlisted.");
  } catch (error) { toast(error.message, true); }
}

async function toggleCoupon(id, active) {
  try {
    await api(`/api/admin/coupons/${id}`, { method: "PUT", body: JSON.stringify({ active }) });
    await loadAdmin("promos");
    toast(active ? "Promo code activated." : "Promo code deactivated.");
  } catch (error) { toast(error.message, true); }
}

async function refundOrder(id) {
  if (!confirm(`Refund order #${id}? This will send a refund through Stripe.`)) return;
  try {
    await api(`/api/admin/orders/${id}/refund`, { method: "POST", body: "{}" });
    await loadAdmin("orders");
    toast("Refund processed.");
  } catch (error) { toast(error.message, true); }
}

async function applyCoupon() {
  const code = $("#coupon-input").value.trim().toUpperCase();
  if (!code) return toast("Enter a promo code first.", true);
  const subtotal = state.cart.map(id => state.products.find(product => product.id === id)).filter(Boolean).reduce((sum, product) => sum + product.price, 0);
  try {
    const result = await api("/api/coupons/validate", { method: "POST", body: JSON.stringify({ code, subtotal }) });
    state.coupon = code;
    state.discount = result.discount;
    renderCart();
    toast(`${result.discount}% off applied.`);
  } catch (error) {
    state.coupon = "";
    state.discount = 0;
    renderCart();
    toast(error.message, true);
  }
}

async function startCheckout() {
  if (!state.cart.length && !state.voucherCart.length) return;
  if (!state.user) {
    hideOverlay($("#cart-overlay"));
    toggleAuth("login");
    return toast("Sign in or create an account to check out.");
  }
  try {
    const result = await api("/api/checkout", {
      method: "POST",
      body: JSON.stringify({ productIds: state.cart, voucherIds: state.voucherCart, coupon: state.coupon })
    });
    location.assign(result.url);
  } catch (error) { toast(error.message, true); }
}

async function refreshAfterPayment() {
  const params = new URLSearchParams(location.search);
  if (params.get("checkout") === "success") {
    history.replaceState({}, "", "/");
    if (state.user) {
      await openAccount();
      await loadCouponOffers();
      toast("Payment confirmed. Your downloads are ready.");
    } else toast("Payment received. Sign in to access your orders.");
    state.cart = [];
    state.voucherCart = [];
    state.coupon = "";
    state.discount = 0;
    persistCart();
  } else if (params.get("checkout") === "cancelled") {
    history.replaceState({}, "", "/");
    toast("Checkout cancelled. Your bag is still here.");
  }
}

function bindEvents() {
  attachOverlayDismiss();
  $("#cart-open").addEventListener("click", () => showOverlay("cart-overlay"));
  $("#search-focus").addEventListener("click", () => {
    if (state.page !== "shop") {
      location.assign("/shop?focus=search");
      return;
    }
    $("#search-input").focus();
  });
  $("#account-button").addEventListener("click", openAccount);
  $("#support-open").addEventListener("click", () => {
    if (state.user) openAccount();
    else toggleAuth("login");
  });
  $("#admin-open").addEventListener("click", () => state.admin ? loadAdmin() : showOverlay("admin-login-overlay"));
  $("#search-input").addEventListener("input", renderProducts);
  $("#sort-select").addEventListener("change", renderProducts);
  $("#coupon-apply").addEventListener("click", applyCoupon);
  $("#coupon-input").addEventListener("input", () => {
    if (!state.coupon) return;
    state.coupon = "";
    state.discount = 0;
    renderCart();
  });
  $("#checkout-button").addEventListener("click", startCheckout);
  $("#auth-switch").addEventListener("click", () => toggleAuth($("#auth-form").dataset.mode === "login" ? "register" : "login"));
  $("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    try {
      await api(form.dataset.mode === "register" ? "/api/register" : "/api/login", { method: "POST", body: JSON.stringify(body) });
      if (form.dataset.mode === "register") {
        state.pendingVerificationEmail = body.email;
        form.elements.password.value = "";
        $("#auth-form-wrap").hidden = true;
        $("#verification-step").hidden = false;
        $("#auth-title").innerHTML = "Check your <span>email.</span>";
        $("#auth-description").textContent = `Enter the six-digit code sent to ${body.email}. The code expires in 10 minutes.`;
        $("#verification-form").elements.code.focus();
        toast("Verification code sent.");
        return;
      }
      await loadIdentity();
      await Promise.all([loadCouponOffers(), loadReviews()]);
      hideOverlay($("#auth-overlay"));
      toast("Welcome back.");
      if (state.cart.length) showOverlay("cart-overlay");
      else openAccount();
    } catch (error) { toast(error.message, true); }
  });
  $("#verification-form").addEventListener("submit", async event => {
    event.preventDefault();
    const code = event.currentTarget.elements.code.value;
    try {
      await api("/api/verify-email", {
        method: "POST",
        body: JSON.stringify({ email: state.pendingVerificationEmail, code })
      });
      state.pendingVerificationEmail = "";
      await loadIdentity();
      await Promise.all([loadCouponOffers(), loadReviews()]);
      hideOverlay($("#auth-overlay"));
      toast("Email verified. Your account is ready.");
      if (state.cart.length) showOverlay("cart-overlay");
      else openAccount();
    } catch (error) { toast(error.message, true); }
  });
  $("#resend-verification").addEventListener("click", async () => {
    if (!state.pendingVerificationEmail) return;
    try {
      await api("/api/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: state.pendingVerificationEmail })
      });
      toast("A new verification code was sent.");
    } catch (error) { toast(error.message, true); }
  });
  $("#admin-login-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ passcode: event.currentTarget.elements.passcode.value }) });
      await loadIdentity();
      hideOverlay($("#admin-login-overlay"));
      await loadAdmin();
      toast("Admin mode unlocked.");
    } catch (error) { toast(error.message, true); }
  });
  $$(".admin-tab").forEach(button => button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab;
    renderAdmin();
  }));
  $("#admin-logout").addEventListener("click", logout);
  $("#admin-close").addEventListener("click", logout);
  $("#product-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const errorMessage = $("#product-form-error");
    if (!submit) return toast("Product form is missing its save button.", true);
    errorMessage.hidden = true;
    submit.disabled = true;
    submit.dataset.originalText = submit.textContent;
    submit.textContent = "Saving…";
    try {
      const body = await readProductForm(form);
      const id = form.elements.id.value;
      await api(id ? `/api/admin/products/${id}` : "/api/admin/products", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
      hideOverlay($("#editor-overlay"));
      await loadStore();
      await loadAdmin("products");
      toast(id ? "Product updated." : "Product added.");
    } catch (error) {
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
      toast(error.message, true);
    } finally {
      submit.disabled = false;
      submit.textContent = submit.dataset.originalText || "Save product";
      delete submit.dataset.originalText;
    }
  });
  $("#category-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/api/admin/categories", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      hideOverlay($("#category-overlay"));
      await loadStore();
      await loadAdmin("games");
      toast("New game category added.");
    } catch (error) { toast(error.message, true); }
  });
  $("#coupon-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/api/admin/coupons", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      hideOverlay($("#coupon-overlay"));
      await loadAdmin("coupons");
      toast("Promo code created.");
    } catch (error) { toast(error.message, true); }
  });
  $$("[data-action=category-add]").forEach(button => button.addEventListener("click", () => {
    if (state.admin) showOverlay("category-overlay");
    else toast("Unlock admin mode to add a game.", true);
  }));
  $("#voucher-offer-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const body = Object.fromEntries(new FormData(form));
    try {
      await api(id ? `/api/admin/coupon-offers/${id}` : "/api/admin/coupon-offers", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(body)
      });
      hideOverlay($("#voucher-editor-overlay"));
      await loadAdmin("coupons");
      await loadCouponOffers();
      toast(id ? "Voucher updated." : "Voucher created.");
    } catch (error) { toast(error.message, true); }
  });
}

async function boot() {
  configurePage();
  bindEvents();
  renderCart();
  try {
    await Promise.all([loadStore(), loadIdentity(), loadCouponOffers(), loadReviews()]);
    renderCart();
    await refreshAfterPayment();
    if (state.page === "shop" && new URLSearchParams(location.search).has("focus")) $("#search-input").focus();
  } catch (error) {
    console.error(error);
    toast("The storefront could not load. Check that the server is running.", true);
  }
}

boot();
