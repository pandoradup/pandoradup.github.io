let products = [];
let mixedProducts = [];
let activeFilter = "todos";
let searchTerm = "";
let cart = [];
let detailProduct = null;
let storeClient = null;
let promotions = [];
let storeCategories = [];
const catalogParams = new URLSearchParams(window.location.search);
const requestedCategory = catalogParams.get("category");
const requestedSearch = catalogParams.get("search");
const defaultAnnouncement = "3 CUOTAS SIN INTERÉS\nENVÍOS A TODO EL PAÍS";
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
})[character]);

function renderAnnouncement(value) {
  const normalized = value.trim() === "3 CUOTAS SIN INTERÉS" ? defaultAnnouncement : value;
  const messages = normalized.split(/\r?\n/).map(message => message.trim()).filter(Boolean);
  const repeated = [...messages, ...messages];
  document.querySelector("[data-announcement-track]").innerHTML = repeated
    .map(message => `<span>${escapeHtml(message)}</span><i aria-hidden="true">✦</i>`)
    .join("");
}

function renderMultilineContent(element, value) {
  const lines = String(value ?? "").split(/\r?\n/);
  element.replaceChildren();
  lines.forEach((line, index) => {
    if (index) element.append(document.createElement("br"));
    element.append(line);
  });
}

if (requestedCategory || requestedSearch) {
  document.body.classList.add("catalog-view");
  activeFilter = requestedCategory || "todos";
  searchTerm = requestedSearch || "";
  document.querySelector("[data-catalog-eyebrow]").textContent = requestedSearch ? "RESULTADOS DE BÚSQUEDA" : "CATÁLOGO";
  document.querySelector("[data-catalog-title]").textContent = requestedSearch
    ? `Resultados para “${requestedSearch}”`
    : requestedCategory === "todos" ? "Todos los productos" : requestedCategory;
  document.querySelector("[data-search-input]").value = searchTerm;
}
try {
  cart = JSON.parse(localStorage.getItem("pandoraCart")) || [];
} catch {
  cart = [];
}
const money = value => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
const PRODUCT_SIZES = ["18 cm", "19 cm", "20 cm"];
const isBraceletCategory = value => /brazalet|pulsera/.test(String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
const needsSize = product => ["base", "composite"].includes(product?.product_type) || isBraceletCategory(product?.category);
const cartItemKey = item => `${item.id}::${item.size || ""}`;
const grid = document.querySelector("[data-products]");

function normalizeSizeStock(source = {}) {
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { source = {}; }
  }
  source = source || {};
  return PRODUCT_SIZES.reduce((result, size) => {
    const centimeters = size.match(/\d+/)?.[0];
    const matchingEntry = Object.entries(source).find(([key]) =>
      String(key).replace(/\s|cm/gi, "") === centimeters
    );
    result[size] = Math.max(0, Number(source?.[size] ?? matchingEntry?.[1]) || 0);
    return result;
  }, {});
}

function sizeStockTotal(source = {}) {
  source = source || {};
  return Object.values(normalizeSizeStock(source)).reduce((total, value) => total + value, 0);
}

function mergeSizeStock(product = {}, fallback = {}) {
  const reported = normalizeSizeStock(product.size_stock);
  return sizeStockTotal(reported) > 0 ? reported : normalizeSizeStock(fallback);
}

function resolvedSizeStock(product = {}) {
  const available = normalizeSizeStock(product.available_size_stock);
  return sizeStockTotal(available) > 0 ? available : normalizeSizeStock(product.size_stock);
}

function productAvailableStock(product = {}) {
  product = product || {};
  const sizedTotal = sizeStockTotal(resolvedSizeStock(product));
  if (!needsSize(product)) return Number(product.stock) || 0;
  if (sizedTotal === 0 && Number(product.stock) > 0) return Number(product.stock);
  return Math.min(sizedTotal, Number(product.stock) || sizedTotal);
}

function productSizeAvailable(product = {}, size = "") {
  product = product || {};
  const sizes = resolvedSizeStock(product);
  const available = Math.max(0, Number(sizes[size]) || 0);
  if (sizeStockTotal(sizes) === 0 && Number(product.stock) > 0) return Number(product.stock);
  return product.product_type === "composite"
    ? Math.min(available, Number(product.stock) || available)
    : available;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function mixProducts(items) {
  const groups = new Map();
  items.forEach(product => {
    if (!groups.has(product.category)) groups.set(product.category, []);
    groups.get(product.category).push(product);
  });
  const categoryGroups = shuffle([...groups.values()]).map(group => shuffle(group));
  const mixed = [];
  while (categoryGroups.some(group => group.length)) {
    categoryGroups.forEach(group => {
      const product = group.shift();
      if (product) mixed.push(product);
    });
  }
  return mixed;
}

function menuHref(item) {
  if (item.target_type === "category") {
    return `index.html?category=${encodeURIComponent(item.target_value)}`;
  }
  if (item.target_type === "section") {
    return item.target_value === "inicio"
      ? "index.html"
      : `index.html#${encodeURIComponent(item.target_value.replace(/^#/, ""))}`;
  }
  if (item.target_type === "page" && /^[a-z0-9][a-z0-9._/-]*(?:[?#].*)?$/i.test(item.target_value) && !item.target_value.includes("..")) {
    return item.target_value;
  }
  if (item.target_type === "external" && /^https?:\/\//i.test(item.target_value)) {
    return item.target_value;
  }
  return "#";
}

function renderMainMenu(menuItems) {
  const categoryLinks = storeCategories.map(category =>
    `<a href="index.html?category=${encodeURIComponent(category.id)}">${escapeHtml(category.name)}</a>`
  ).join("");
  document.querySelector("[data-main-menu]").innerHTML = `
    <a href="index.html#productos">Novedades</a>
    <div class="nav-product-menu">
      <button type="button" data-products-menu aria-expanded="false">Productos <span aria-hidden="true">⌄</span></button>
      <div class="nav-product-dropdown">
        ${categoryLinks}
        <a class="view-all-products" href="index.html?category=todos">Ver todo</a>
      </div>
    </div>
    <a href="index.html#promos">Promos</a>
    <a href="index.html#materiales">Materiales</a>
    <a href="index.html#contacto">Contacto</a>`;
}

function promotionRequirementText(requirement) {
  const labels = {
    base: "Brazaletes",
    charm: "Charms",
    simple: "Otros",
    composite: "Pulseras"
  };
  if (requirement.matcher === "product_type") {
    const category = labels[requirement.value] || requirement.value;
    return `${requirement.quantity} ${requirement.quantity === 1 ? "artículo" : "artículos"} de la categoría ${category}`;
  }
  if (requirement.matcher === "category") {
    const category = storeCategories.find(item => String(item.id) === String(requirement.value));
    const categoryName = category?.name || requirement.value;
    return `${requirement.quantity} ${requirement.quantity === 1 ? "artículo" : "artículos"} de la categoría ${categoryName}`;
  }
  const product = products.find(item => String(item.id) === String(requirement.value));
  return `${requirement.quantity} ${requirement.quantity === 1 ? "unidad" : "unidades"} de ${product?.name || "un producto específico"}`;
}

function joinPromotionRequirements(requirements) {
  if (requirements.length < 2) return requirements[0] || "";
  return `${requirements.slice(0, -1).join(", ")} y ${requirements.at(-1)}`;
}

function renderPromotionShowcase() {
  const activePromotions = promotions.filter(promotion => window.PromotionEngine.isActive(promotion));
  const section = document.querySelector("[data-promotions-section]");
  section.classList.toggle("hidden", activePromotions.length === 0);
  document.querySelector("[data-store-promotions]").innerHTML = activePromotions.map(promotion => `
    <article class="promotion-card">
      ${promotion.image_url ? `<img class="promotion-card-image" loading="lazy" decoding="async" src="${escapeHtml(promotion.image_url)}" alt="">` : ""}
      <h3>${escapeHtml(promotion.name)}</h3>
      <p>Agregá ${joinPromotionRequirements(promotion.requirements.map(promotionRequirementText))}.</p>
      <strong>${promotion.type === "gift" ? `${escapeHtml(promotion.gift)} de regalo` : money(promotion.price)}</strong>
      <a href="#productos">ELEGIR PRODUCTOS <span>→</span></a>
    </article>`).join("");
}

function normalizeStoreProduct(product) {
  const sizeStock = normalizeSizeStock(product.size_stock);
  const availableSizeStock = resolvedSizeStock(product);
  const availableStock = Number(product.available_stock ?? (sizeStockTotal(availableSizeStock) || product.stock || 0));
  return {
    ...product,
    physical_stock: product.stock,
    size_stock: sizeStock,
    available_size_stock: availableSizeStock,
    stock: availableStock,
    old: product.old_price,
    image: product.image_url
  };
}

async function refreshProductAvailability() {
  if (!storeClient) return;
  const [{ data, error }, { data: sizeRows }] = await Promise.all([
    storeClient.rpc("get_store_products"),
    storeClient.from("products").select("id,size_stock")
  ]);
  if (error) return;
  const sizesById = new Map((sizeRows || []).map(row => [String(row.id), row.size_stock]));
  products = (data || []).map(product => normalizeStoreProduct({
    ...product,
    size_stock: mergeSizeStock(product, sizesById.get(String(product.id)))
  }));
  mixedProducts = mixProducts(products);
  renderProducts();
  if (detailProduct) {
    const updatedDetail = products.find(product => product.id === detailProduct.id);
    if (updatedDetail) openProductDetail(updatedDetail);
  }
}

async function refreshPublicMenu() {
  if (!storeClient) return;
  const [{ data, error }, { data: categories, error: categoriesError }] = await Promise.all([
    storeClient.from("menu_items").select("*").eq("published", true).order("sort_order").order("id"),
    storeClient.from("categories").select("id,name").eq("published", true).order("sort_order")
  ]);
  if (!error && !categoriesError) {
    storeCategories = categories || [];
    renderMainMenu(data || []);
  }
}

function renderProducts() {
  const source = mixedProducts.length === products.length ? mixedProducts : products;
  const isCatalogView = document.body.classList.contains("catalog-view");
  const visible = source.filter(product =>
    (activeFilter === "todos" || product.category === activeFilter) &&
    (isCatalogView || productAvailableStock(product) > 0) &&
    product.name.toLowerCase().includes(searchTerm.toLowerCase())
  ).sort((a, b) => isCatalogView ? Number(productAvailableStock(a) === 0) - Number(productAvailableStock(b) === 0) : 0);
  grid.innerHTML = visible.map(product => {
    const availableStock = productAvailableStock(product);
    const photos = [...new Set([product.image, ...(product.gallery_urls || [])].filter(Boolean))];
    return `
    <article class="product-card">
      <div class="product-image" data-product-open="${product.id}">
        <div class="product-photo-track" data-card-photos aria-label="Fotos de ${escapeHtml(product.name)}">
          ${photos.map((photo, index) => `<img src="${escapeHtml(photo)}" alt="${escapeHtml(product.name)} · Foto ${index + 1} de ${photos.length}" loading="lazy" decoding="async" draggable="false">`).join("")}
        </div>
        ${photos.length > 1 ? `<button type="button" class="card-photo-arrow card-photo-prev" data-card-photo="-1" aria-label="Foto anterior">‹</button><button type="button" class="card-photo-arrow card-photo-next" data-card-photo="1" aria-label="Foto siguiente">›</button><span class="card-photo-count" data-card-photo-count>1 / ${photos.length}</span>` : ""}
        ${availableStock === 0
          ? `<span class="product-badge out-of-stock">SIN STOCK</span>`
          : availableStock <= 2
            ? `<span class="product-badge low-stock">¡QUEDAN POCOS!</span>`
            : product.badge ? `<span class="product-badge">${product.badge}</span>` : ""}
        <button class="quick-add" data-add="${product.id}" ${availableStock === 0 ? "disabled" : ""}>
          ${availableStock === 0 ? "SIN STOCK" : "AGREGAR A LA BOLSA +"}
        </button>
      </div>
      <div class="product-info" data-product-open="${product.id}">
        <h3>${product.name}</h3>
        <div class="product-price">${product.old ? `<del>${money(product.old)}</del>` : ""}<span>${money(product.price)}</span></div>
      </div>
    </article>`;
  }).join("");
  grid.scrollLeft = 0;
  document.querySelector("[data-empty]").classList.toggle("visible", visible.length === 0);
}

function showProductImage(url, selectedButton) {
  const image = document.querySelector("[data-product-detail-image]");
  image.src = url;
  document.querySelectorAll("[data-product-thumbnail]").forEach(button =>
    button.classList.toggle("active", button === selectedButton)
  );
}

function openProductDetail(product) {
  detailProduct = product;
  const photos = [...new Set([product.image, ...(product.gallery_urls || [])].filter(Boolean))];
  document.querySelector("[data-product-detail-image]").src = photos[0];
  document.querySelector("[data-product-detail-image]").alt = product.name;
  document.querySelector("[data-product-detail-name]").textContent = product.name;
  document.querySelector("[data-product-detail-category]").textContent = product.category;
  document.querySelector("[data-product-detail-price]").innerHTML =
    `${product.old ? `<del>${money(product.old)}</del>` : ""}<span>${money(product.price)}</span>`;
  const stock = productAvailableStock(product);
  const stockText = stock === 1 ? "1 unidad disponible" : `${stock} unidades disponibles`;
  document.querySelector("[data-product-detail-stock]").innerHTML = stock === 0
    ? "Sin stock"
    : `${stock <= 2 ? '<span class="low-stock-warning">¡Quedan pocas unidades!</span>' : ""}<span>${stockText}</span>`;
  const sizeField = document.querySelector("[data-product-size-field]");
  const sizeSelect = document.querySelector("[data-product-size]");
  sizeField.classList.toggle("hidden", !needsSize(product));
  if (needsSize(product)) {
    sizeSelect.innerHTML = `<option value="">Seleccioná un talle</option>` + PRODUCT_SIZES.map(size => {
      const available = productSizeAvailable(product, size);
      const label = available > 0
        ? `${size} · ${available} ${available === 1 ? "disponible" : "disponibles"}`
        : `${size} · Sin stock`;
      return `<option value="${escapeHtml(size)}" ${available === 0 ? "disabled" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
  }
  sizeSelect.value = "";
  const addButton = document.querySelector("[data-product-detail-add]");
  addButton.disabled = stock === 0;
  addButton.firstChild.textContent = stock === 0 ? "SIN STOCK " : "AGREGAR AL CARRITO ";
  document.querySelector("[data-product-thumbnails]").innerHTML = photos.map((url, index) => `
    <button type="button" class="${index === 0 ? "active" : ""}" data-product-thumbnail="${url}" aria-label="Ver foto ${index + 1}">
      <img src="${url}" alt="">
    </button>`).join("");
  document.querySelector("[data-product-detail]").classList.add("open");
  document.querySelector("[data-product-detail]").setAttribute("aria-hidden", "false");
  document.querySelector("[data-product-detail-overlay]").classList.add("open");
  document.body.classList.add("no-scroll");
}

function closeProductDetail() {
  document.querySelector("[data-product-detail]").classList.remove("open");
  document.querySelector("[data-product-detail]").setAttribute("aria-hidden", "true");
  document.querySelector("[data-product-detail-overlay]").classList.remove("open");
  document.body.classList.remove("no-scroll");
  detailProduct = null;
}

// Background images below the fold should not compete with the storefront hero.
const backgroundObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(entries => {
      entries.forEach(({ target, isIntersecting }) => {
        if (!isIntersecting) return;
        target.style.backgroundImage = `url(${JSON.stringify(target.dataset.backgroundSrc)})`;
        backgroundObserver.unobserve(target);
      });
    }, { rootMargin: "250px" })
  : null;

function setStoreBackground(element, url, priority = false) {
  if (!url) return;
  element.dataset.backgroundSrc = url;
  if (priority || !backgroundObserver) {
    element.style.backgroundImage = `url(${JSON.stringify(url)})`;
  } else {
    backgroundObserver.observe(element);
  }
}

function applyStoreContent(content) {
  const contentValues = Object.fromEntries(content.map(item => [item.key, item.value]));
  content.forEach(item => {
    if (document.body.classList.contains("catalog-view") &&
        ["products_kicker", "products_title"].includes(item.key)) return;
    if (item.key === "announcement") {
      renderAnnouncement(item.value);
      return;
    }
    if (item.key === "hero_button_url") {
      const safeDestination = /^(?:https?:\/\/[^\s]+|#[a-z0-9_-]+|[a-z0-9][a-z0-9._/-]*(?:[?#].*)?)$/i.test(item.value) &&
        !item.value.includes("..");
      if (safeDestination) document.querySelector("[data-hero-button]").href = item.value;
      return;
    }
    if (item.key === "contact_button_url") {
      const safeDestination = /^(?:https?:\/\/[^\s]+|#[a-z0-9_-]+|[a-z0-9][a-z0-9._/-]*(?:[?#].*)?)$/i.test(item.value) &&
        !item.value.includes("..");
      if (safeDestination) document.querySelector("[data-contact-button]").href = item.value;
      return;
    }
    const element = document.querySelector(`[data-content="${item.key}"]`);
    if (element) {
      if (element.hasAttribute("data-multiline-content")) renderMultilineContent(element, item.value);
      else element.textContent = item.value;
    }
    const image = document.querySelector(`[data-content-image="${item.key}"]`);
    if (image) {
      setStoreBackground(image, item.value, item.key === "hero_image");
      const x = contentValues[`${item.key}_position_x`] || 50;
      const y = contentValues[`${item.key}_position_y`] || 50;
      image.style.backgroundPosition = `${x}% ${y}%`;
    }
  });
  document.querySelectorAll("[data-balanced-lines]").forEach(element => {
    const text = element.textContent.trim();
    const midpoint = Math.floor(text.length / 2);
    const before = text.lastIndexOf(" ", midpoint);
    const after = text.indexOf(" ", midpoint);
    const breakAt = before < 0 ? after : after < 0 || midpoint - before <= after - midpoint ? before : after;
    if (breakAt > 0) {
      element.replaceChildren(text.slice(0, breakAt), document.createElement("br"), text.slice(breakAt + 1));
    }
  });
}

async function loadStoreData() {
  try {
    const { createSupabaseClient, isSupabaseConfigured } = await import("./supabase-client.js");
    if (!isSupabaseConfigured) return;
    const client = await createSupabaseClient();
    storeClient = client;
    // Paint the homepage as soon as its content arrives, independently of stock.
    const contentRequest = client.from("site_content").select("key,value").then(result => {
      if (!result.error && result.data) applyStoreContent(result.data);
      return result;
    });
    const storeRequest = Promise.all([
      client.rpc("get_store_products"),
      client.from("products").select("id,size_stock"),
      contentRequest,
      client.from("categories").select("*").eq("published", true).order("sort_order")
    ]);
    let timeoutId;
    const storeTimeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error("La conexión con la tienda demoró demasiado.")), 8000);
    });
    const [
      { data: remoteProducts, error: productsError },
      { data: sizeRows },
      { data: content, error: contentError },
      { data: categories, error: categoriesError }
    ] = await Promise.race([storeRequest, storeTimeout]).finally(() => clearTimeout(timeoutId));
    if (productsError && contentError && categoriesError) {
      throw new Error("El servicio de la tienda no está disponible.");
    }
    if (!productsError && remoteProducts?.length) {
      const sizesById = new Map((sizeRows || []).map(row => [String(row.id), row.size_stock]));
      products = remoteProducts.map(product => normalizeStoreProduct({
        ...product,
        size_stock: mergeSizeStock(product, sizesById.get(String(product.id)))
      }));
      mixedProducts = mixProducts(products);
      renderProducts();
    }
    const contentValues = !contentError
      ? Object.fromEntries(content.map(item => [item.key, item.value]))
      : {};
    promotions = window.PromotionEngine.parse(contentValues.promotions_config);
    localStorage.setItem("pandoraPromotions", JSON.stringify(promotions));
    renderPromotionShowcase();
    if (!categoriesError) {
      storeCategories = categories || [];
      renderMainMenu();
    }
    if (categories?.length) {
      const categoryNames = categories.map(category => category.name.toLocaleLowerCase("es-AR"));
      document.querySelector("[data-search-input]").placeholder =
        `Buscar ${categoryNames.slice(0, 3).join(", ")}${categoryNames.length > 3 ? "..." : ""}`;
      document.querySelector("[data-category-filters]").innerHTML =
        `<button class="active" data-filter="todos">Todo</button>` +
        categories.map(category => `<button data-filter="${escapeHtml(category.id)}">${escapeHtml(category.name)}</button>`).join("");
      document.querySelector("[data-store-categories]").innerHTML = categories.map(category => {
        const imageUrl = category.image_url || contentValues[`category_${category.id}_image`] || "";
        return `
          <a href="#productos" data-filter-link="${escapeHtml(category.id)}" class="category"
            ${imageUrl ? `data-background-src="${escapeHtml(imageUrl)}"` : ""}>
            <span>${escapeHtml(category.name)}</span>
          </a>`;
      }).join("");
      document.querySelectorAll("[data-store-categories] [data-background-src]").forEach(element =>
        setStoreBackground(element, element.dataset.backgroundSrc)
      );
      document.querySelectorAll("[data-filter]").forEach(button =>
        button.addEventListener("click", () => setFilter(button.dataset.filter))
      );
      document.querySelectorAll("[data-filter]").forEach(button =>
        button.classList.toggle("active", button.dataset.filter === activeFilter)
      );
      if (requestedCategory) {
        const category = categories.find(item => item.id === requestedCategory);
        if (category) document.querySelector("[data-catalog-title]").textContent = category.name;
      }
    }
    updateCart();
  } catch (error) {
    console.warn("No se pudo cargar el catálogo administrable.", error);
    const emptyState = document.querySelector("[data-empty]");
    emptyState.textContent = "No pudimos conectar con la tienda. Tus productos siguen guardados; volvé a intentar en unos minutos.";
    emptyState.classList.add("visible", "load-error");
    document.querySelector("[data-products]").setAttribute("aria-busy", "false");
  }
}

function setFilter(filter) {
  openCategoryView(filter);
}

function moveCarousel(direction) {
  const card = grid.querySelector(".product-card");
  const distance = card ? card.getBoundingClientRect().width + 18 : grid.clientWidth * 0.8;
  grid.scrollBy({ left: direction * distance, behavior: "smooth" });
}

document.querySelector("[data-carousel-prev]").addEventListener("click", () => moveCarousel(-1));
document.querySelector("[data-carousel-next]").addEventListener("click", () => moveCarousel(1));

function moveCategoryCarousel(direction) {
  const categoryGrid = document.querySelector("[data-store-categories]");
  const category = categoryGrid.querySelector(".category");
  const distance = category ? category.getBoundingClientRect().width + 18 : categoryGrid.clientWidth * 0.8;
  categoryGrid.scrollBy({ left: direction * distance, behavior: "smooth" });
}

document.querySelector("[data-category-prev]").addEventListener("click", () => moveCategoryCarousel(-1));
document.querySelector("[data-category-next]").addEventListener("click", () => moveCategoryCarousel(1));

function movePromotionCarousel(direction) {
  const promotionGrid = document.querySelector("[data-store-promotions]");
  const card = promotionGrid.querySelector(".promotion-card");
  const distance = card ? card.getBoundingClientRect().width + 18 : promotionGrid.clientWidth * 0.8;
  promotionGrid.scrollBy({ left: direction * distance, behavior: "smooth" });
}

document.querySelector("[data-promotion-prev]").addEventListener("click", () => movePromotionCarousel(-1));
document.querySelector("[data-promotion-next]").addEventListener("click", () => movePromotionCarousel(1));

function openCategoryView(category) {
  if (category === "todos") {
    window.location.href = "index.html?category=todos";
    return;
  }
  window.location.href = `index.html?category=${encodeURIComponent(category)}`;
}

document.querySelectorAll("[data-home-logo]").forEach(logo => {
  logo.addEventListener("click", event => {
    const isMainView = !window.location.search;
    if (!isMainView) return;
    event.preventDefault();
    history.replaceState(null, "", window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

function openSearchView() {
  const term = document.querySelector("[data-search-input]").value.trim();
  if (!term) return;
  window.location.href = `index.html?search=${encodeURIComponent(term)}`;
}

function updateCart() {
  document.querySelectorAll("[data-cart-count]").forEach(el => el.textContent = cart.length);
  const items = document.querySelector("[data-cart-items]");
  const grouped = Object.values(cart.reduce((result, item) => {
    const key = cartItemKey(item);
    if (!result[key]) result[key] = { ...item, cartKey: key, quantity: 0 };
    result[key].quantity += 1;
    return result;
  }, {}));
  items.innerHTML = grouped.map(item => `
    <article class="cart-item" data-cart-product="${item.id}" role="button" tabindex="0"
      aria-label="Ver detalle de ${item.name}">
      <img src="${item.image || item.image_url}" alt="${item.name}">
      <div class="cart-item-info">
        ${item.badge ? `<span class="cart-item-badge">${item.badge}</span>` : ""}
        <h4>${item.name}</h4>
        <p>${item.category || "Accesorios"}${item.size ? ` · Talle ${escapeHtml(item.size)}` : ""}</p>
        <button class="remove-item" type="button" data-remove-product="${escapeHtml(item.cartKey)}" aria-label="Eliminar ${item.name}">
          <span aria-hidden="true">⌫</span> Eliminar producto
        </button>
      </div>
      <div class="cart-item-actions">
        <strong>${money(item.price * item.quantity)}</strong>
        <div class="quantity-control" aria-label="Cantidad de ${item.name}">
          <button type="button" data-decrease="${escapeHtml(item.cartKey)}" aria-label="Restar uno">−</button>
          <span>${item.quantity} UN.</span>
          <button type="button" data-increase="${escapeHtml(item.cartKey)}" aria-label="Sumar uno">+</button>
        </div>
      </div>
    </article>`).join("");
  document.querySelector("[data-cart-empty]").classList.toggle("hidden", cart.length > 0);
  document.querySelector("[data-cart-footer]").classList.toggle("hidden", cart.length === 0);
  const pricing = window.PromotionEngine.calculate(cart, products, promotions);
  document.querySelector("[data-cart-promotions]").innerHTML = pricing.applications.map(application => `
    <div class="cart-promotion">
      <strong>✓ Promo: ${escapeHtml(application.name)}${application.applications > 1 ? ` ×${application.applications}` : ""}</strong>
      <span>${application.gift
        ? `Incluye ${escapeHtml(application.gift)} de regalo`
        : `Ahorrás ${money(application.saving)} · Precio promo ${money(application.promotionalAmount)}`}</span>
    </div>`).join("");
  document.querySelector("[data-cart-subtotal]").textContent = money(pricing.subtotal);
  document.querySelector("[data-cart-total]").textContent = money(pricing.total);
  localStorage.setItem("pandoraCart", JSON.stringify(cart));
  localStorage.setItem("pandoraPricing", JSON.stringify(pricing));
}

function toggleCart(open) {
  document.querySelector("[data-cart]").classList.toggle("open", open);
  document.querySelector("[data-overlay]").classList.toggle("open", open);
  document.body.classList.toggle("no-scroll", open);
}

function groupedCartPayload(items) {
  return Object.values(items.reduce((groups, item) => {
    const key = cartItemKey(item);
    if (!groups[key]) groups[key] = { id: item.id, size: item.size || null, quantity: 0 };
    groups[key].quantity += 1;
    return groups;
  }, {}));
}

function showCartToast(text) {
  const toast = document.querySelector("[data-toast]");
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}

function animateProductAdded(productId) {
  const cards = new Set(
    [...document.querySelectorAll(`[data-product-open="${productId}"]`)]
      .map(element => element.closest(".product-card"))
      .filter(Boolean)
  );
  cards.forEach(card => {
    card.classList.remove("just-added");
    void card.offsetWidth;
    card.classList.add("just-added");
    setTimeout(() => card.classList.remove("just-added"), 1500);
  });
  if (detailProduct?.id === productId) {
    const detail = document.querySelector("[data-product-detail]");
    const button = document.querySelector("[data-product-detail-add]");
    const originalText = button.firstChild.textContent;
    detail.classList.add("just-added");
    button.firstChild.textContent = "✓ AGREGADO ";
    setTimeout(() => {
      detail.classList.remove("just-added");
      button.firstChild.textContent = originalText;
    }, 1500);
  }
}

async function tryAddToCart(product, size = null) {
  if (!product || productAvailableStock(product) <= 0) return false;
  if (needsSize(product) && !size) {
    showCartToast("Seleccioná un talle");
    return false;
  }
  if (needsSize(product) && productSizeAvailable(product, size) <= 0) {
    showCartToast("Ese talle no tiene stock");
    return false;
  }
  const nextItem = { ...product, size: size || null };
  const nextCart = [...cart, nextItem];
  if (storeClient) {
    const { data: hasStock, error } = await storeClient.rpc("validate_cart_stock", {
      p_items: groupedCartPayload(nextCart)
    });
    if (error || !hasStock) {
      showCartToast("No hay stock suficiente para esta combinación");
      return false;
    }
  } else {
    const quantity = nextCart.filter(item => cartItemKey(item) === cartItemKey(nextItem)).length;
    const available = needsSize(product) ? productSizeAvailable(product, size) : productAvailableStock(product);
    if (quantity > available) return false;
  }
  cart.push(nextItem);
  updateCart();
  animateProductAdded(product.id);
  showCartToast("Agregado a tu bolsa ♡");
  return true;
}

function openProductFromCart(productId) {
  const product = products.find(item => String(item.id) === String(productId));
  if (!product) return;
  toggleCart(false);
  openProductDetail(product);
}

document.addEventListener("click", async event => {
  const photoArrow = event.target.closest("[data-card-photo]");
  if (photoArrow) {
    const track = photoArrow.closest(".product-image").querySelector("[data-card-photos]");
    track.scrollBy({ left: Number(photoArrow.dataset.cardPhoto) * track.clientWidth, behavior: "smooth" });
    return;
  }
  const photoTrack = event.target.closest("[data-card-photos]");
  if (photoTrack && Date.now() < Number(photoTrack.dataset.suppressClickUntil || 0)) return;
  const add = event.target.closest("[data-add]");
  if (add) {
    event.stopPropagation();
    const product = products.find(item => item.id === Number(add.dataset.add));
    if (needsSize(product)) {
      openProductDetail(product);
      return;
    }
    await tryAddToCart(product);
    return;
  }
  const decrease = event.target.closest("[data-decrease]");
  if (decrease) {
    const index = cart.findIndex(item => cartItemKey(item) === decrease.dataset.decrease);
    if (index >= 0) cart.splice(index, 1);
    updateCart();
  }
  const increase = event.target.closest("[data-increase]");
  if (increase) {
    const existingItem = cart.find(item => cartItemKey(item) === increase.dataset.increase);
    const product = products.find(item => item.id === existingItem?.id) || existingItem;
    await tryAddToCart(product, existingItem?.size || null);
    return;
  }
  const remove = event.target.closest("[data-remove-product]");
  if (remove) {
    cart = cart.filter(item => cartItemKey(item) !== remove.dataset.removeProduct);
    updateCart();
  }
  const cartProduct = event.target.closest("[data-cart-product]");
  const cartControl = event.target.closest("[data-decrease], [data-increase], [data-remove-product]");
  if (cartProduct && !cartControl) {
    openProductFromCart(cartProduct.dataset.cartProduct);
    return;
  }
  const filterLink = event.target.closest("[data-filter-link]");
  if (filterLink) {
    event.preventDefault();
    openCategoryView(filterLink.dataset.filterLink);
  }
  const productOpen = event.target.closest("[data-product-open]");
  if (productOpen && !event.target.closest("[data-add]")) {
    const product = products.find(item => item.id === Number(productOpen.dataset.productOpen));
    if (product) openProductDetail(product);
  }
  const thumbnail = event.target.closest("[data-product-thumbnail]");
  if (thumbnail) showProductImage(thumbnail.dataset.productThumbnail, thumbnail);
});

document.querySelector("[data-product-detail-add]").addEventListener("click", async () => {
  if (!detailProduct || productAvailableStock(detailProduct) === 0) return;
  const size = needsSize(detailProduct) ? document.querySelector("[data-product-size]").value : null;
  await tryAddToCart(detailProduct, size);
});
document.querySelector("[data-product-detail-close]").addEventListener("click", closeProductDetail);
document.querySelector("[data-product-detail-overlay]").addEventListener("click", closeProductDetail);

document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => setFilter(button.dataset.filter)));
document.querySelector("[data-cart-button]").addEventListener("click", async () => {
  await refreshProductAvailability();
  toggleCart(true);
});
document.querySelectorAll("[data-cart-close]").forEach(button => button.addEventListener("click", () => toggleCart(false)));
document.querySelector("[data-checkout-start]").addEventListener("click", () => {
  localStorage.setItem("pandoraCart", JSON.stringify(cart));
  window.open("checkout.html?v=20260718-1", "_blank", "noopener");
});
document.querySelector("[data-clear-cart]").addEventListener("click", () => {
  cart = [];
  updateCart();
});
document.querySelector("[data-overlay]").addEventListener("click", () => toggleCart(false));
document.querySelector("[data-menu-button]").addEventListener("click", () => document.querySelector("[data-nav]").classList.toggle("open"));
document.querySelector("[data-nav]").addEventListener("click", event => {
  const productsButton = event.target.closest("[data-products-menu]");
  if (productsButton) {
    const menu = productsButton.closest(".nav-product-menu");
    const open = menu.classList.toggle("open");
    productsButton.setAttribute("aria-expanded", String(open));
    return;
  }
  const link = event.target.closest("a");
  if (!link) return;
  document.querySelector("[data-nav]").classList.remove("open");
  document.querySelector(".nav-product-menu")?.classList.remove("open");
  if (!link.matches("[data-menu-home]")) return;
  event.preventDefault();
  closeProductDetail();
  toggleCart(false);
  if (window.location.search || !/\/(?:index\.html)?$/i.test(window.location.pathname)) {
    window.location.href = "index.html";
    return;
  }
  history.replaceState(null, "", window.location.pathname);
  window.scrollTo({ top: 0, behavior: "smooth" });
});
const searchPanel = document.querySelector("[data-search-panel]");
const searchButton = document.querySelector("[data-search-button]");
function toggleSearch(open) {
  searchPanel.classList.toggle("open", open);
  searchButton.setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("[data-search-input]").focus();
}
searchButton.addEventListener("click", () => toggleSearch(true));
document.querySelector("[data-search-close]").addEventListener("click", () => toggleSearch(false));
document.addEventListener("keydown", event => {
  const cartProduct = event.target.closest("[data-cart-product]");
  if (cartProduct && event.target === cartProduct && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openProductFromCart(cartProduct.dataset.cartProduct);
    return;
  }
  if (event.key === "Escape") {
    toggleSearch(false);
    closeProductDetail();
  }
});
document.querySelector("[data-search-submit]").addEventListener("click", openSearchView);
document.querySelector("[data-search-input]").addEventListener("keydown", event => {
  if (event.key === "Enter") openSearchView();
});
window.addEventListener("storage", event => {
  if (event.key === "pandoraMenuUpdatedAt") refreshPublicMenu();
  if (event.key === "pandoraProductsUpdatedAt") refreshProductAvailability();
  if (event.key === "pandoraPromotionsUpdatedAt") loadStoreData();
  if (event.key === "pandoraCart" && event.newValue === null) {
    cart = [];
    updateCart();
    refreshProductAvailability();
  }
});
window.addEventListener("focus", async () => {
  await refreshProductAvailability();
});

grid.addEventListener("scroll", event => {
  const track = event.target;
  if (!track.matches("[data-card-photos]")) return;
  track.dataset.suppressClickUntil = String(Date.now() + 350);
  const count = track.parentElement.querySelector("[data-card-photo-count]");
  if (count && track.clientWidth) count.textContent = `${Math.round(track.scrollLeft / track.clientWidth) + 1} / ${track.children.length}`;
}, true);
let photoGesture;
grid.addEventListener("pointerdown", event => {
  const track = event.target.closest("[data-card-photos]");
  photoGesture = track ? { track, x: event.clientX, y: event.clientY } : null;
});
grid.addEventListener("pointermove", event => {
  if (photoGesture && Math.hypot(event.clientX - photoGesture.x, event.clientY - photoGesture.y) > 10) {
    photoGesture.track.dataset.suppressClickUntil = String(Date.now() + 500);
  }
});
grid.addEventListener("pointerup", () => { photoGesture = null; });
grid.addEventListener("pointercancel", () => { photoGesture = null; });
renderMainMenu();
renderProducts();
updateCart();
loadStoreData();
