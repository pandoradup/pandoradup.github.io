import {
  createSupabaseClient,
  isSupabaseConfigured
} from "./supabase-client.js";

const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0
}).format(value || 0);

let supabase;
let products = [];
let orders = [];
let categories = [];
let categoriesHaveImageColumn = true;
let promotions = [];
let promotionRequirementsDirty = false;
const editedImages = new WeakMap();
let editedGalleryFiles = [];
let galleryEditQueue = [];
let cropState = null;
const PRODUCT_SIZES = ["18 cm", "19 cm", "20 cm"];

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;"
})[character]);

function message(selector, text, error = false) {
  const element = $(selector);
  element.textContent = text;
  element.classList.toggle("error", error);
}

function showLogin() {
  document.body.removeAttribute("data-admin-authenticated");
  $("[data-login-view]").classList.remove("hidden");
  $("[data-dashboard]").classList.add("hidden");
}

function showDashboard(email) {
  $("[data-login-view]").classList.add("hidden");
  $("[data-dashboard]").classList.remove("hidden");
  $("[data-admin-email]").textContent = email;
  document.body.setAttribute("data-admin-authenticated", "");
}

function renderProducts() {
  const list = $("[data-product-list]");
  const sortedProducts = [...products].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "es-AR", { sensitivity: "base", numeric: true })
  );
  list.innerHTML = sortedProducts.map(product => {
    const stock = getAdminAvailableStock(product);
    const status = !product.published
      ? { className: "unpublished", label: "No publicado" }
      : stock === 0
        ? { className: "out-of-stock", label: "Sin stock" }
        : { className: "", label: "Publicado" };
    return `
    <article class="admin-product">
      <img src="${escapeHtml(product.image_url)}" alt="" loading="lazy" decoding="async">
      <div>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.category)} · ${money(product.price)} · Stock: ${stock}${product.product_type === "composite" ? " calculado" : ""}</p>
      </div>
      <span class="status ${status.className}">${status.label}</span>
      <button type="button" data-edit-product="${product.id}">EDITAR</button>
    </article>
  `}).join("");
  $("[data-products-empty]").classList.toggle("hidden", products.length > 0);
  $("[data-metric-published]").textContent = products.filter(product => product.published).length;
  $("[data-metric-empty]").textContent = products.filter(product => getAdminAvailableStock(product) === 0).length;
  $("[data-metric-stock]").textContent = products
    .filter(product => product.product_type !== "composite")
    .reduce((total, product) => total + getAdminAvailableStock(product), 0);
}

function normalizedSizeStock(product = {}) {
  product = product || {};
  const saved = product.size_stock || {};
  const available = product.available_size_stock || {};
  return PRODUCT_SIZES.reduce((result, size) => {
    result[size] = Math.max(0, Number(saved?.[size] ?? available?.[size]) || 0);
    return result;
  }, {});
}

function sizeStockTotal(product = {}) {
  product = product || {};
  return Object.values(normalizedSizeStock(product)).reduce((total, value) => total + value, 0);
}

function isBraceletCategory(value = "") {
  const category = categories.find(item => String(item.id) === String(value));
  const text = `${value} ${category?.name || ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /brazalet|pulsera/.test(text);
}

function usesSizeStock(product = {}) {
  product = product || {};
  return product.product_type === "base" || isBraceletCategory(product.category);
}

function collectSizeStock(form) {
  return PRODUCT_SIZES.reduce((result, size) => {
    result[size] = Math.max(0, Number(form.elements[`size_stock_${size}`]?.value) || 0);
    return result;
  }, {});
}

function fillSizeStockFields(product = {}) {
  product = product || {};
  const values = normalizedSizeStock(product);
  PRODUCT_SIZES.forEach(size => {
    const field = $("[data-product-form]").elements[`size_stock_${size}`];
    if (field) field.value = values[size] || 0;
  });
}

function isMissingSizeStockColumn(error) {
  return /size_stock/i.test(error?.message || "") && /schema cache|column/i.test(error?.message || "");
}

async function saveProductRecord(record, id = "", options = {}) {
  const runSave = payload => {
    const query = id
      ? supabase.from("products").update(payload).eq("id", Number(id))
      : supabase.from("products").insert(payload);
    return query.select("id").single();
  };
  let result = await runSave(record);
  if (result.error && isMissingSizeStockColumn(result.error)) {
    if (options.requireSizeStock) {
      return {
        data: null,
        error: new Error("Para guardar stock por talle primero ejecutá el SQL de stock en Supabase. Si no, Supabase no tiene creada la columna size_stock.")
      };
    }
    const fallbackRecord = { ...record };
    delete fallbackRecord.size_stock;
    result = await runSave(fallbackRecord);
  }
  return result;
}

function getAdminAvailableStock(product) {
  product = product || {};
  if (product.product_type !== "composite") return usesSizeStock(product) ? sizeStockTotal(product) : Number(product.stock) || 0;
  if (!product.components?.length) return 0;
  return Math.min(...product.components.map(component => {
    const physicalProduct = products.find(item => item.id === component.component_product_id);
    const availableUnits = usesSizeStock(physicalProduct)
      ? sizeStockTotal(physicalProduct)
      : Number(physicalProduct?.stock) || 0;
    return Math.floor(availableUnits / component.quantity);
  }));
}

function orderWhatsAppMessage(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const products = items.map(item =>
    `• ${item.name}${item.size ? ` · Talle ${item.size}` : ""} × ${Number(item.quantity) || 1}`
  ).join("\n");
  const address = order.address
    ? `\nDirección: ${order.address}${order.city ? `, ${order.city}` : ""}${order.postal_code ? ` (CP ${order.postal_code})` : ""}`
    : "";
  return `¡Hola, ${order.customer_name}! 😊 Somos Pandora DUP.

Recibimos tu pedido y vamos a preparar tu paquete con lo que elegiste:
${products}

Número de pedido: ${order.order_number}
Total de tu compra: ${money(order.total)}
Modalidad de entrega: ${order.delivery_method}${address}${order.address ? "\nEl costo del envío se coordina por separado." : ""}

¡Gracias por tu compra! Coordinamos por acá los detalles del pago y la entrega. 💕`;
}

function renderOrders() {
  const activeOrders = orders.filter(order => ["pending", "contacted"].includes(order.status));
  const labels = { pending: "Sin contactar", contacted: "Contactado", completed: "Completado" };
  $("[data-order-list]").innerHTML = activeOrders.map(order => {
    const items = Array.isArray(order.items) ? order.items : [];
    const phoneLink = String(order.phone).replace(/\D/g, "");
    return `
      <article class="admin-order">
        <div class="order-top">
          <div>
            <h3>${escapeHtml(order.order_number)} · ${escapeHtml(order.customer_name)}</h3>
            <p>${new Date(order.created_at).toLocaleString("es-AR")}</p>
          </div>
          <span class="order-status ${order.status}">${labels[order.status] || order.status}</span>
        </div>
        <div class="order-details">
          <div><span>Teléfono</span><strong>${escapeHtml(order.phone)}</strong></div>
          <div><span>Pago</span><strong>${escapeHtml(order.payment_method)}</strong></div>
          <div><span>Entrega</span><strong>${escapeHtml(order.delivery_method)}</strong></div>
          <div><span>Total</span><strong>${money(order.total)}</strong></div>
        </div>
        <ul class="order-products">
          ${items.map(item => `<li>${escapeHtml(item.name)}${item.size ? ` · Talle: ${escapeHtml(item.size)}` : ""} × ${Number(item.quantity) || 1}</li>`).join("")}
        </ul>
        <div class="order-actions">
          <a href="https://wa.me/${phoneLink}?text=${encodeURIComponent(orderWhatsAppMessage(order))}" target="_blank" rel="noopener">CONTACTAR POR WHATSAPP ↗</a>
          ${order.status === "pending"
            ? `<button class="primary-order-action" type="button" data-order-status="contacted" data-order-id="${order.id}">MARCAR CONTACTADO</button>`
            : ""}
          <button type="button" data-order-status="completed" data-order-id="${order.id}">MARCAR COMPLETADO</button>
          <button class="danger-action" type="button" data-order-status="cancelled" data-order-id="${order.id}">CANCELAR PEDIDO</button>
        </div>
      </article>
    `;
  }).join("");
  $("[data-orders-empty]").classList.toggle("hidden", activeOrders.length > 0);
  $("[data-metric-pending]").textContent = orders.filter(order => order.status === "pending").length;
  $("[data-metric-contacted]").textContent = orders.filter(order => order.status === "contacted").length;
  $("[data-metric-completed]").textContent = orders.filter(order => order.status === "completed").length;
}

async function loadOrders() {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  orders = data;
  renderOrders();
}

async function loadProducts() {
  const [{ data, error }, { data: componentRows, error: componentsError }] = await Promise.all([
    supabase
    .from("products")
    .select("*")
    .order("sort_order")
    .order("id"),
    supabase.from("product_components").select("*")
  ]);
  if (error) throw error;
  if (componentsError) throw componentsError;
  products = (data || []).map(product => ({
    ...product,
    components: (componentRows || []).filter(row => row.composite_product_id === product.id)
  }));
  renderProducts();
}

function renderCategories() {
  $("[data-category-list]").innerHTML = categories.map(category => `
    <article class="admin-product ${category.image_url ? "" : "no-image"}">
      ${category.image_url
        ? `<img src="${escapeHtml(category.image_url)}" alt="Foto de ${escapeHtml(category.name)}">`
        : ""}
      <div><h3>${escapeHtml(category.name)}</h3><p>${escapeHtml(category.id)} · Orden ${category.sort_order}</p></div>
      <span class="status ${category.published ? "" : "draft"}">${category.published ? "Publicada" : "Oculta"}</span>
      <div class="category-actions">
        <button type="button" data-edit-category="${escapeHtml(category.id)}">EDITAR</button>
        <button class="delete-category" type="button" data-delete-category="${escapeHtml(category.id)}">ELIMINAR</button>
      </div>
    </article>`).join("");
  const select = $("[data-product-form]").elements.category;
  select.innerHTML = categories.map(category =>
    `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join("");
}

async function loadCategories() {
  const [{ data, error }, { data: categoryImages, error: imagesError }] = await Promise.all([
    supabase.from("categories").select("*").order("sort_order"),
    supabase.from("site_content").select("key,value").like("key", "category_%_image")
  ]);
  if (error) throw error;
  if (imagesError) throw imagesError;
  categoriesHaveImageColumn = !data?.length ||
    Object.prototype.hasOwnProperty.call(data[0], "image_url");
  const imageValues = Object.fromEntries((categoryImages || []).map(item => [item.key, item.value]));
  categories = (data || []).map(category => ({
    ...category,
    image_url: category.image_url || imageValues[`category_${category.id}_image`] || null
  }));
  renderCategories();
}

function resetCategoryForm() {
  const form = $("[data-category-form]");
  clearPendingImage(form.elements.image);
  form.reset();
  form.elements.original_id.value = "";
  form.elements.image_url.value = "";
  form.elements.published.checked = true;
  $("[data-category-image-preview]").innerHTML = "";
  $("[data-category-form-title]").textContent = "Categorías";
  $("[data-cancel-category]").classList.add("hidden");
}

function categoryIdFromName(name) {
  const base = name.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "categoria";
  let id = base;
  let suffix = 2;
  while (categories.some(category => String(category.id) === id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

async function loadContent() {
  const { data, error } = await supabase.from("site_content").select("key,value");
  if (error) throw error;
  const forms = [...document.querySelectorAll("[data-content-section-form]")];
  data.forEach(item => {
    const field = forms.map(form => form.elements[item.key]).find(Boolean);
    if (field) {
      field.value = item.value;
    }
    if (item.key === "promotions_config") {
      try {
        const savedPromotions = JSON.parse(item.value);
        promotions = Array.isArray(savedPromotions) ? savedPromotions : [];
      } catch {
        promotions = [];
      }
    }
  });
  document.querySelectorAll(".photo-field").forEach(updatePhotoPreview);
  renderPromotions();
  if (!$("[data-promotion-requirements]").children.length) renderPromotionRequirements();
}

function promotionMatcherOptions(matcher, selectedValue = "") {
  const options = matcher === "product"
    ? products.map(product => ({ value: product.id, label: product.name }))
    : matcher === "category"
      ? categories.map(category => ({ value: category.id, label: category.name }))
      : [
          { value: "base", label: "Brazalete" },
          { value: "charm", label: "Charm" },
          { value: "simple", label: "Otro" },
          { value: "composite", label: "Pulsera" }
        ];
  return options.map(option =>
    `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(selectedValue) ? "selected" : ""}>${escapeHtml(option.label)}</option>`
  ).join("");
}

function addPromotionRequirement(requirement = {}) {
  const matcher = requirement.matcher || "product_type";
  const row = document.createElement("div");
  row.className = "promotion-requirement-row";
  row.innerHTML = `
    <select data-promotion-matcher>
      <option value="product_type" ${matcher === "product_type" ? "selected" : ""}>Tipo de producto</option>
      <option value="category" ${matcher === "category" ? "selected" : ""}>Categoría</option>
      <option value="product" ${matcher === "product" ? "selected" : ""}>Producto específico</option>
    </select>
    <select data-promotion-value required>${promotionMatcherOptions(matcher, requirement.value)}</select>
    <input data-promotion-quantity type="number" min="1" step="1" value="${requirement.quantity || 1}" aria-label="Cantidad necesaria" required>
    <button type="button" data-remove-promotion-requirement aria-label="Quitar requisito">×</button>`;
  $("[data-promotion-requirements]").append(row);
}

function renderPromotionRequirements(requirements = []) {
  $("[data-promotion-requirements]").innerHTML = "";
  (requirements.length ? requirements : [{}]).forEach(addPromotionRequirement);
}

function renderPromotions() {
  $("[data-promotion-list]").innerHTML = promotions.map(promotion => `
    <article class="admin-product">
      <div><h3>${escapeHtml(promotion.name)}</h3><p>${promotion.type === "gift" ? `Regalo: ${escapeHtml(promotion.gift)}` : money(promotion.price)} · ${promotion.requirements.length} requisitos · Prioridad ${promotion.priority || 0}${promotion.exclusive ? " · No combinable" : ""}</p></div>
      <span class="status ${promotion.active ? "" : "draft"}">${promotion.active ? "Activa" : "Inactiva"}</span>
      <div class="category-actions">
        <button type="button" data-edit-promotion="${escapeHtml(promotion.id)}">EDITAR</button>
        <button class="delete-category" type="button" data-delete-promotion="${escapeHtml(promotion.id)}">ELIMINAR</button>
      </div>
    </article>`).join("");
}

function resetPromotionForm() {
  const form = $("[data-promotion-form]");
  clearPendingImage(form.elements.promotion_image);
  form.reset();
  form.elements.id.value = "";
  form.elements.active.checked = true;
  form.elements.exclusive.checked = false;
  form.elements.promotion_image_url.value = "";
  $("[data-promotion-image-preview]").innerHTML = "";
  promotionRequirementsDirty = false;
  updatePromotionTypeFields();
  $("[data-promotion-form-title]").textContent = "Promociones automáticas";
  $("[data-cancel-promotion]").classList.add("hidden");
  renderPromotionRequirements();
}

function updatePromotionTypeFields() {
  const form = $("[data-promotion-form]");
  const isGift = form.elements.promotion_type.value === "gift";
  $("[data-promotion-price-field]").classList.toggle("hidden", isGift);
  $("[data-promotion-gift-field]").classList.toggle("hidden", !isGift);
  form.elements.price.required = !isGift;
  form.elements.gift.required = isGift;
}

async function persistPromotions(messageText, nextPromotions = promotions) {
  const { error } = await supabase.from("site_content").upsert({
    key: "promotions_config",
    value: JSON.stringify(nextPromotions),
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
  promotions = nextPromotions;
  localStorage.setItem("pandoraPromotionsUpdatedAt", String(Date.now()));
  renderPromotions();
  message("[data-promotion-message]", messageText);
}

function updatePhotoPreview(field) {
  const fileInput = field.querySelector('input[type="file"]');
  const key = fileInput.name.replace(/_file$/, "");
  const url = field.dataset.previewUrl || field.querySelector(`input[name="${key}"]`).value;
  let preview = field.querySelector(".photo-preview");
  if (!preview) {
    preview = document.createElement("div");
    preview.className = "photo-preview";
    preview.style.aspectRatio = String(cropConfig(fileInput).ratio);
    field.prepend(preview);
  }
  preview.style.backgroundImage = url ? `url("${url}")` : "none";
  preview.style.backgroundPosition =
    `${field.querySelector(`[name="${key}_position_x"]`).value}% ${field.querySelector(`[name="${key}_position_y"]`).value}%`;
}

function renderProductPhotoPreviews() {
  const form = $("[data-product-form]");
  const mainUrl = form.elements.image_url.value;
  const galleryUrls = JSON.parse(form.elements.gallery_urls.value || "[]");
  $("[data-main-image-preview]").innerHTML = mainUrl ? `
    <article class="product-photo-thumbnail">
      <img src="${escapeHtml(mainUrl)}" alt="Foto principal actual">
      <button type="button" data-remove-main-image>ELIMINAR</button>
    </article>` : `<p class="photo-preview-empty">No hay una foto principal guardada.</p>`;
  $("[data-gallery-preview]").innerHTML = galleryUrls.length ? galleryUrls.map((url, index) => `
    <article class="product-photo-thumbnail">
      <img src="${escapeHtml(url)}" alt="Foto adicional ${index + 1}">
      <span class="photo-order-label">${index === 0 ? "SEGUNDA IMAGEN" : `FOTO ${index + 2}`}</span>
      <div class="photo-order-actions">
        <button type="button" data-move-gallery-image="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="Mover foto a la izquierda">←</button>
        <button type="button" data-move-gallery-image="${index}" data-direction="1" ${index === galleryUrls.length - 1 ? "disabled" : ""} aria-label="Mover foto a la derecha">→</button>
        <button type="button" data-remove-gallery-image="${index}">ELIMINAR</button>
      </div>
    </article>`).join("") : `<p class="photo-preview-empty">No hay fotos adicionales guardadas.</p>`;
}

function destinationFrame(url, type, label) {
  return url ? `<div class="destination-frame ${type}-frame"><img src="${escapeHtml(url)}" alt="Vista previa"><span>${label}</span></div>` : "";
}

function renderPendingUploadPreview(input, file = null) {
  const url = file ? URL.createObjectURL(file) : "";
  if (input.closest("[data-category-form]")) {
    $("[data-category-image-preview]").innerHTML = destinationFrame(url || input.form.elements.image_url.value, "category", "ASÍ SE VERÁ EN CATEGORÍAS") + (file ? `<button class="adjust-upload-button" type="button" data-readjust-image>AJUSTAR FOTO</button>` : "");
  } else if (input.name === "promotion_image") {
    $("[data-promotion-image-preview]").innerHTML = destinationFrame(url || input.form.elements.promotion_image_url.value, "promotion", "ASÍ SE VERÁ EN PROMOCIONES") + (file ? `<button class="adjust-upload-button" type="button" data-readjust-image>AJUSTAR FOTO</button>` : "");
  } else if (input.name === "image" && url) {
    $("[data-main-image-preview]").innerHTML = `<article class="product-photo-thumbnail"><img src="${escapeHtml(url)}" alt="Vista previa de la foto principal"><span class="photo-order-label">ASÍ SE VERÁ</span><button class="adjust-upload-button" type="button" data-readjust-image>AJUSTAR FOTO</button></article>`;
  }
  const photoField = input.closest(".photo-field");
  if (photoField && file) {
    let button = photoField.querySelector("[data-readjust-image]");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "adjust-upload-button";
      button.dataset.readjustImage = "";
      button.textContent = "AJUSTAR FOTO";
      photoField.querySelector(".photo-preview")?.after(button);
    }
  }
}

function renderPendingGalleryPreview() {
  if (!editedGalleryFiles.length) return;
  $("[data-gallery-preview]").innerHTML = editedGalleryFiles.map((file, index) => `
    <article class="product-photo-thumbnail"><img src="${escapeHtml(URL.createObjectURL(file))}" alt="Vista previa de foto adicional ${index + 1}"><span class="photo-order-label">${index === 0 ? "SEGUNDA IMAGEN" : `FOTO ${index + 2}`}</span><button class="adjust-upload-button" type="button" data-readjust-gallery="${index}">AJUSTAR FOTO</button></article>`).join("");
}

function clearPendingImage(input) {
  if (!input) return;
  editedImages.delete(input);
  input.value = "";
  input.closest("label")?.classList.remove("image-ready");
  const photoField = input.closest(".photo-field");
  if (photoField?.dataset.previewUrl) {
    URL.revokeObjectURL(photoField.dataset.previewUrl);
    delete photoField.dataset.previewUrl;
  }
}

function openProduct(product = null) {
  const form = $("[data-product-form]");
  clearPendingImage(form.elements.image);
  clearPendingImage(form.elements.gallery);
  form.reset();
  editedGalleryFiles = [];
  galleryEditQueue = [];
  const defaultCategory = categories[0]?.id || form.elements.category.options[0]?.value || "";
  form.elements.id.value = product?.id || "";
  form.elements.name.value = product?.name || "";
  form.elements.category.value = product?.category || defaultCategory;
  form.elements.product_type.value = product?.product_type || "charm";
  form.elements.badge.value = product?.badge || "";
  form.elements.price.value = product?.price || "";
  form.elements.old_price.value = product?.old_price || "";
  form.elements.stock.value = product?.stock ?? 0;
  fillSizeStockFields(product);
  form.elements.sort_order.value = product?.sort_order ?? 0;
  form.elements.image_url.value = product?.image_url || "";
  form.elements.gallery_urls.value = JSON.stringify(product?.gallery_urls || []);
  renderProductPhotoPreviews();
  form.elements.published.checked = product?.published ?? true;
  renderComponentRows(product?.components || []);
  updateProductTypeFields();
  $("[data-product-form-title]").textContent = product ? "Editar producto" : "Nuevo producto";
  $("[data-delete-product]").classList.toggle("hidden", !product);
  message("[data-product-message]", "");
  $("[data-product-modal]").classList.remove("hidden");
}

function openNewProduct() {
  try {
    openProduct();
  } catch (error) {
    alert(`No se pudo abrir el formulario de producto: ${error.message}`);
  }
}


$("[data-main-image-preview]").addEventListener("click", event => {
  if (!event.target.closest("[data-remove-main-image]")) return;
  const form = $("[data-product-form]");
  clearPendingImage(form.elements.image);
  form.elements.image_url.value = "";
  renderProductPhotoPreviews();
});

$("[data-gallery-preview]").addEventListener("click", event => {
  const removeButton = event.target.closest("[data-remove-gallery-image]");
  const moveButton = event.target.closest("[data-move-gallery-image]");
  if (!removeButton && !moveButton) return;
  const form = $("[data-product-form]");
  const galleryUrls = JSON.parse(form.elements.gallery_urls.value || "[]");
  if (removeButton) {
    galleryUrls.splice(Number(removeButton.dataset.removeGalleryImage), 1);
  } else {
    const from = Number(moveButton.dataset.moveGalleryImage);
    const to = from + Number(moveButton.dataset.direction);
    if (to < 0 || to >= galleryUrls.length) return;
    [galleryUrls[from], galleryUrls[to]] = [galleryUrls[to], galleryUrls[from]];
  }
  form.elements.gallery_urls.value = JSON.stringify(galleryUrls);
  renderProductPhotoPreviews();
});

function componentOptions(selectedId = "") {
  const currentId = Number($("[data-product-form]").elements.id.value);
  return products
    .filter(product => ["charm", "base"].includes(product.product_type) && product.id !== currentId)
    .map(product => `<option value="${product.id}" ${String(product.id) === String(selectedId) ? "selected" : ""}>
      ${escapeHtml(product.name)} · ${product.product_type === "base" ? "Brazalete" : "Charm"} · Stock ${getAdminAvailableStock(product)}
    </option>`).join("");
}

function addComponentRow(component = {}) {
  const row = document.createElement("div");
  row.className = "component-row";
  row.innerHTML = `
    <select data-component-product required>
      <option value="">Elegí un producto</option>
      ${componentOptions(component.component_product_id)}
    </select>
    <input data-component-quantity type="number" min="1" step="1" value="${component.quantity || 1}" aria-label="Cantidad utilizada" required>
    <button type="button" data-remove-component aria-label="Quitar componente">×</button>`;
  $("[data-component-list]").append(row);
}

function renderComponentRows(components) {
  $("[data-component-list]").innerHTML = "";
  components.forEach(addComponentRow);
}

function updateProductTypeFields() {
  const form = $("[data-product-form]");
  const composite = form.elements.product_type.value === "composite";
  const sized = !composite && (form.elements.product_type.value === "base" || isBraceletCategory(form.elements.category.value));
  $("[data-components-editor]").classList.toggle("hidden", !composite);
  $("[data-product-stock-field]").classList.toggle("hidden", composite || sized);
  $("[data-size-stock-editor]").classList.toggle("hidden", !sized);
  form.elements.stock.required = !composite && !sized;
  if (composite) form.elements.stock.value = 0;
}

function closeProduct() {
  const form = $("[data-product-form]");
  clearPendingImage(form.elements.image);
  clearPendingImage(form.elements.gallery);
  editedGalleryFiles = [];
  galleryEditQueue = [];
  $("[data-product-modal]").classList.add("hidden");
}

async function uploadImage(file, bucket = "products") {
  const extension = file.name.split(".").pop().toLowerCase();
  const path = `${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false
  });
  if (error) throw error;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

function cropConfig(input) {
  if (input.name === "hero_image_file") return { ratio: 1.25, label: "Portada de inicio · encuadre principal" };
  if (input.name === "editorial_main_image_file") return { ratio: 0.82, label: "Editorial principal" };
  if (input.name === "editorial_small_image_file") return { ratio: 1.5, label: "Editorial secundaria" };
  if (input.name === "promotion_image") return { ratio: 2.4, label: "Tarjeta de promoción" };
  if (input.closest("[data-category-form]")) return { ratio: 0.58, label: "Tarjeta de categoría" };
  if (input.name === "gallery") return { ratio: 0.78, label: "Galería de producto · tarjeta de catálogo" };
  return { ratio: 0.78, label: "Producto · tarjeta de catálogo" };
}

function drawCrop() {
  if (!cropState) return;
  const canvas = $("[data-crop-canvas]");
  const stage = $("[data-crop-stage]");
  const context = canvas.getContext("2d");
  const { image, ratio } = cropState;
  const outputWidth = ratio >= 1 ? 1200 : Math.round(1200 * ratio);
  const outputHeight = Math.round(outputWidth / ratio);
  stage.style.aspectRatio = String(ratio);
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const coverScale = Math.max(outputWidth / image.naturalWidth, outputHeight / image.naturalHeight);
  const scale = coverScale * Number($("[data-crop-zoom]").value);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const availableX = Math.max(0, (width - outputWidth) / 2);
  const availableY = Math.max(0, (height - outputHeight) / 2);
  const offsetX = Number($("[data-crop-x]").value) / 100 * availableX;
  const offsetY = Number($("[data-crop-y]").value) / 100 * availableY;

  context.fillStyle = "#f5f1e8";
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.drawImage(
    image,
    (outputWidth - width) / 2 + offsetX,
    (outputHeight - height) / 2 + offsetY,
    width,
    height
  );
}

function closeImageEditor(resetInput = false) {
  if (resetInput && cropState?.input) {
    cropState.input.value = "";
    if (cropState.input.name === "gallery") {
      editedGalleryFiles = [];
      galleryEditQueue = [];
    }
  }
  if (cropState?.objectUrl) URL.revokeObjectURL(cropState.objectUrl);
  cropState = null;
  $("[data-crop-stage]").style.aspectRatio = "";
  $("[data-image-editor]").classList.add("hidden");
}

function openImageEditor(input, file, galleryIndex = null) {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    const config = cropConfig(input);
    cropState = {
      input,
      image,
      objectUrl,
      galleryIndex,
      ratio: config.ratio
    };
    $("[data-crop-destination]").textContent = `Vista exacta: ${config.label}`;
    $("[data-crop-zoom]").value = "1";
    $("[data-crop-x]").value = "0";
    $("[data-crop-y]").value = "0";
    $("[data-image-editor]").classList.remove("hidden");
    drawCrop();
  };
  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    input.value = "";
    alert("No se pudo abrir esa imagen.");
  };
  image.src = objectUrl;
}

document.querySelectorAll('input[type="file"][accept*="image"]').forEach(input => {
  input.addEventListener("change", () => {
    const files = [...input.files];
    if (!files.length) return;
    if (input.name === "gallery") {
      editedGalleryFiles = [];
      galleryEditQueue = files.slice(1).map((file, index) => ({ file, index: index + 1 }));
    }
    openImageEditor(input, files[0], input.name === "gallery" ? 0 : null);
  });
});
document.querySelectorAll(".photo-field").forEach(field => {
  field.querySelectorAll('input[type="range"]').forEach(control =>
    control.addEventListener("input", () => updatePhotoPreview(field))
  );
});

document.querySelectorAll("[data-crop-zoom],[data-crop-x],[data-crop-y]")
  .forEach(control => control.addEventListener("input", drawCrop));
document.querySelectorAll("[data-image-cancel]")
  .forEach(button => button.addEventListener("click", () => closeImageEditor(true)));
$("[data-image-apply]").addEventListener("click", () => {
  if (!cropState) return;
  const { input } = cropState;
  $("[data-crop-canvas]").toBlob(blob => {
    if (!blob) return;
    const file = new File([blob], `${crypto.randomUUID()}.webp`, { type: "image/webp" });
    editedImages.set(input, file);
    input.closest("label").classList.add("image-ready");
    const photoField = input.closest(".photo-field");
    if (photoField) {
      if (photoField.dataset.previewUrl) URL.revokeObjectURL(photoField.dataset.previewUrl);
      photoField.dataset.previewUrl = URL.createObjectURL(file);
      updatePhotoPreview(photoField);
    }
    if (input.name === "gallery") {
      editedGalleryFiles[cropState.galleryIndex] = file;
      if (galleryEditQueue.length) {
        const next = galleryEditQueue.shift();
        closeImageEditor();
        openImageEditor(input, next.file, next.index);
        return;
      }
      renderPendingGalleryPreview();
    } else {
      renderPendingUploadPreview(input, file);
    }
    closeImageEditor();
  }, "image/webp", 0.9);
});

document.addEventListener("click", event => {
  const galleryButton = event.target.closest("[data-readjust-gallery]");
  if (galleryButton) {
    const input = $("[data-product-form]").elements.gallery;
    const index = Number(galleryButton.dataset.readjustGallery);
    const original = input.files[index];
    if (original) openImageEditor(input, original, index);
    return;
  }
  const button = event.target.closest("[data-readjust-image]");
  if (!button) return;
  const field = button.closest(".photo-field");
  const input = field?.querySelector('input[type="file"]')
    || button.closest("[data-category-form]")?.elements.image
    || button.closest("[data-promotion-form]")?.elements.promotion_image
    || $("[data-product-form]").elements.image;
  const original = input?.files[0];
  if (original) openImageEditor(input, original);
});

async function verifyAdmin(user) {
  const { data, error } = await supabase
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data) {
    await supabase.auth.signOut();
    throw new Error("Esta cuenta no tiene permisos de administración.");
  }
}

async function initAdmin() {
  if (!isSupabaseConfigured) {
    $("[data-setup-warning]").classList.remove("hidden");
    $("[data-login-form] button").disabled = true;
    return;
  }
  supabase = await createSupabaseClient();
  showLogin();
  $("[data-login-form] button").disabled = false;
}

async function loadDashboardData() {
  const panels = [...document.querySelectorAll("[data-panel]")];
  panels.forEach(panel => { panel.inert = true; });
  const status = $("[data-dashboard-loading]");
  status.textContent = "Cargando las secciones del panel...";
  status.classList.remove("error");
  const unlock = async (promise, names) => {
    await promise;
    panels.filter(panel => names.includes(panel.dataset.panel)).forEach(panel => { panel.inert = false; });
  };
  const ordersReady = loadOrders();
  const categoriesReady = loadCategories();
  const productsReady = loadProducts();
  const contentReady = loadContent();
  const results = await Promise.allSettled([
    unlock(ordersReady, ["orders"]),
    unlock(categoriesReady, ["categories"]),
    unlock(Promise.all([productsReady, categoriesReady]), ["products"]),
    unlock(contentReady, ["content"]),
    unlock(Promise.all([productsReady, categoriesReady, contentReady]), ["promotions"])
  ]);
  const failed = results.some(result => result.status === "rejected");
  status.textContent = failed ? "No se pudieron cargar algunas secciones. Recargá el panel para reintentar." : "";
  status.classList.toggle("error", failed);
}

$("[data-login-form]").addEventListener("submit", async event => {
  event.preventDefault();
  const loginForm = event.currentTarget;
  const button = loginForm.querySelector('[type="submit"]');
  button.disabled = true;
  message("[data-login-message]", "Ingresando...");
  const form = new FormData(loginForm);
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: form.get("email"),
      password: form.get("password")
    });
    if (error) return message("[data-login-message]", "Correo o contraseña incorrectos.", true);
    await verifyAdmin(data.user);
    showDashboard(data.user.email);
    loginForm.reset();
    await loadDashboardData();
  } catch (adminError) {
    showLogin();
    message("[data-login-message]", adminError.message, true);
  } finally {
    button.disabled = false;
  }
});

$("[data-logout]").addEventListener("click", async () => {
  showLogin();
  await supabase.auth.signOut();
});

window.addEventListener("pagehide", showLogin);

document.querySelectorAll("[data-tab]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach(item => item.classList.toggle("active", item === button));
    document.querySelectorAll("[data-panel]").forEach(panel =>
      panel.classList.toggle("hidden", panel.dataset.panel !== button.dataset.tab)
    );
  });
});

document.querySelectorAll("[data-admin-home-logo]").forEach(logo => {
  logo.addEventListener("click", event => {
    event.preventDefault();
    const firstTab = document.querySelector("[data-tab]");
    if (firstTab && !firstTab.classList.contains("active")) firstTab.click();
    history.replaceState(null, "", window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

$("[data-refresh-orders]").addEventListener("click", loadOrders);
$("[data-order-list]").addEventListener("click", async event => {
  const button = event.target.closest("[data-order-status]");
  if (!button) return;
  const status = button.dataset.orderStatus;
  if (status === "cancelled" && !confirm("¿Cancelar este pedido y devolver sus productos al stock?")) return;
  button.disabled = true;
  const update = { status };
  if (status === "contacted") update.contacted_at = new Date().toISOString();
  if (status === "completed") update.completed_at = new Date().toISOString();
  const { error } = await supabase
    .from("orders")
    .update(update)
    .eq("id", Number(button.dataset.orderId));
  if (error) {
    button.disabled = false;
    alert(error.message);
    return;
  }
  await Promise.all([loadOrders(), loadProducts()]);
  if (status === "cancelled") localStorage.setItem("pandoraProductsUpdatedAt", String(Date.now()));
});

$("[data-new-product]").addEventListener("click", openNewProduct);
$("[data-product-list]").addEventListener("click", event => {
  const button = event.target.closest("[data-edit-product]");
  if (button) openProduct(products.find(product => product.id === Number(button.dataset.editProduct)));
});
document.querySelectorAll("[data-close-product]").forEach(button => button.addEventListener("click", closeProduct));
$("[data-product-form]").elements.product_type.addEventListener("change", () => {
  updateProductTypeFields();
  if ($("[data-product-form]").elements.product_type.value === "composite" &&
      !$("[data-component-list]").children.length) addComponentRow();
});
$("[data-product-form]").elements.category.addEventListener("change", updateProductTypeFields);
$("[data-add-component]").addEventListener("click", () => addComponentRow());
$("[data-component-list]").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-component]");
  if (button) button.closest(".component-row").remove();
});

$("[data-category-form]").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  message("[data-category-message]", "Guardando...");
  try {
    let imageUrl = form.elements.image_url.value;
    const categoryImage = editedImages.get(form.elements.image) || form.elements.image.files[0];
    if (categoryImage) imageUrl = await uploadImage(categoryImage, "site");
    const name = form.elements.name.value.trim();
    const originalId = form.elements.original_id.value;
    const record = {
      id: originalId || categoryIdFromName(name),
      name,
      sort_order: Number(form.elements.sort_order.value),
      published: form.elements.published.checked
    };
    if (categoriesHaveImageColumn) record.image_url = imageUrl || null;
    const query = originalId
      ? supabase.from("categories").update(record).eq("id", originalId)
      : supabase.from("categories").insert(record);
    const { data, error } = await query.select("id").single();
    if (error) throw error;
    if (!data) throw new Error("La categoría no pudo guardarse. Actualizá la lista e intentá nuevamente.");
    if (imageUrl) {
      const { error: imageError } = await supabase.from("site_content").upsert({
        key: `category_${record.id}_image`,
        value: imageUrl,
        updated_at: new Date().toISOString()
      });
      if (imageError) throw imageError;
    }
    resetCategoryForm();
    await Promise.all([loadCategories(), loadProducts()]);
    localStorage.setItem("pandoraMenuUpdatedAt", String(Date.now()));
    message("[data-category-message]", originalId ? "Categoría actualizada." : "Categoría creada.");
  } catch (error) {
    message("[data-category-message]", error.message, true);
  }
});

$("[data-category-list]").addEventListener("click", event => {
  const editButton = event.target.closest("[data-edit-category]");
  const deleteButton = event.target.closest("[data-delete-category]");
  if (deleteButton) {
    deleteCategory(deleteButton.dataset.deleteCategory);
    return;
  }
  if (!editButton) return;
  const categoryId = String(editButton.dataset.editCategory);
  const category = categories.find(item => String(item.id) === categoryId);
  if (!category) {
    message("[data-category-message]", "No se encontró la categoría. La lista se actualizará.", true);
    loadCategories().catch(error => message("[data-category-message]", error.message, true));
    return;
  }
  const form = $("[data-category-form]");
  clearPendingImage(form.elements.image);
  form.elements.original_id.value = String(category.id);
  form.elements.name.value = category.name;
  form.elements.image_url.value = category.image_url || "";
  renderPendingUploadPreview(form.elements.image);
  form.elements.sort_order.value = category.sort_order;
  form.elements.published.checked = category.published;
  $("[data-category-form-title]").textContent = `Editar ${category.name}`;
  $("[data-cancel-category]").classList.remove("hidden");
  message("[data-category-message]", `Estás editando la categoría ${category.name}.`);
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => form.elements.name.focus(), 450);
});

$("[data-cancel-category]").addEventListener("click", () => {
  resetCategoryForm();
  message("[data-category-message]", "");
});

async function deleteCategory(categoryId) {
  const category = categories.find(item => String(item.id) === String(categoryId));
  if (!category || !confirm(`¿Querés eliminar la categoría “${category.name}”?`)) return;
  message("[data-category-message]", "Eliminando...");
  const { error } = await supabase.from("categories").delete().eq("id", category.id);
  if (error) {
    const text = error.code === "23503"
      ? "No se puede eliminar porque tiene productos asociados. Cambiá esos productos de categoría primero."
      : error.message;
    message("[data-category-message]", text, true);
    return;
  }
  if ($("[data-category-form]").elements.original_id.value === String(category.id)) resetCategoryForm();
  await loadCategories();
  localStorage.setItem("pandoraMenuUpdatedAt", String(Date.now()));
  message("[data-category-message]", "Categoría eliminada.");
}

$("[data-product-form]").addEventListener("submit", async event => {
  event.preventDefault();
  message("[data-product-message]", "Guardando...");
  const form = event.currentTarget;
  const id = form.elements.id.value;
  try {
    if (!form.elements.category.value ||
        !categories.some(category => category.id === form.elements.category.value)) {
      throw new Error("Elegí una categoría válida para el producto.");
    }
    const productType = form.elements.product_type.value;
    const components = [...$("[data-component-list]").querySelectorAll(".component-row")]
      .map(row => ({
        productId: Number(row.querySelector("[data-component-product]").value),
        quantity: Number(row.querySelector("[data-component-quantity]").value)
      }))
      .filter(component => component.productId);
    if (productType === "composite") {
      if (!components.length) throw new Error("Agregá el brazalete y los charms de la pulsera.");
      if (new Set(components.map(component => component.productId)).size !== components.length) {
        throw new Error("Cada componente debe aparecer una sola vez. Ajustá su cantidad en la misma fila.");
      }
      const selectedProducts = components.map(component =>
        products.find(product => product.id === component.productId)
      );
      if (selectedProducts.filter(product => product?.product_type === "base").length !== 1) {
        throw new Error("La pulsera debe usar exactamente un brazalete.");
      }
      if (selectedProducts.some(product => !product || !["base", "charm"].includes(product.product_type))) {
        throw new Error("La pulsera solo puede incluir un brazalete y charms.");
      }
    }
    const usesSizes = productType !== "composite" &&
      (productType === "base" || isBraceletCategory(form.elements.category.value));
    const storedProductType = usesSizes ? "base" : productType;
    const sizeStock = usesSizes ? collectSizeStock(form) : {};
    let imageUrl = form.elements.image_url.value;
    const productImage = editedImages.get(form.elements.image) || form.elements.image.files[0];
    if (productImage) imageUrl = await uploadImage(productImage);
    if (!imageUrl) throw new Error("Subí una foto o ingresá la URL de una imagen.");
    let galleryUrls = JSON.parse(form.elements.gallery_urls.value || "[]");
    if (editedGalleryFiles.length || form.elements.gallery.files.length) {
      const uploadedGallery = await Promise.all(
        (editedGalleryFiles.length ? editedGalleryFiles : [...form.elements.gallery.files]).map(file => uploadImage(file))
      );
      galleryUrls = [...galleryUrls, ...uploadedGallery];
    }
    const record = {
      name: form.elements.name.value.trim(),
      category: form.elements.category.value,
      badge: form.elements.badge.value.trim() || null,
      price: Number(form.elements.price.value),
      old_price: form.elements.old_price.value ? Number(form.elements.old_price.value) : null,
      stock: productType === "composite" ? 0 : usesSizes ? sizeStockTotal({ size_stock: sizeStock }) : Number(form.elements.stock.value),
      size_stock: sizeStock,
      product_type: storedProductType,
      sort_order: Number(form.elements.sort_order.value || 0),
      image_url: imageUrl,
      gallery_urls: galleryUrls,
      published: form.elements.published.checked,
      updated_at: new Date().toISOString()
    };
    const { data: savedProduct, error } = await saveProductRecord(record, id, {
      requireSizeStock: usesSizes
    });
    if (error) throw error;
    const { error: componentsError } = await supabase.rpc("replace_product_components", {
      p_product_id: savedProduct.id,
      p_components: productType === "composite" ? components : []
    });
    if (componentsError) throw componentsError;
    await loadProducts();
    localStorage.setItem("pandoraProductsUpdatedAt", String(Date.now()));
    closeProduct();
  } catch (error) {
    message("[data-product-message]", error.message, true);
  }
});

$("[data-delete-product]").addEventListener("click", async () => {
  const id = Number($("[data-product-form]").elements.id.value);
  if (!id || !confirm("¿Querés eliminar este producto definitivamente?")) return;
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return message("[data-product-message]", error.message, true);
  await loadProducts();
  localStorage.setItem("pandoraProductsUpdatedAt", String(Date.now()));
  closeProduct();
});

$("[data-add-promotion-requirement]").addEventListener("click", () => {
  addPromotionRequirement();
  promotionRequirementsDirty = true;
});
$("[data-promotion-form]").elements.promotion_type.addEventListener("change", updatePromotionTypeFields);
$("[data-promotion-requirements]").addEventListener("change", event => {
  promotionRequirementsDirty = true;
  const matcher = event.target.closest("[data-promotion-matcher]");
  if (!matcher) return;
  const row = matcher.closest(".promotion-requirement-row");
  row.querySelector("[data-promotion-value]").innerHTML = promotionMatcherOptions(matcher.value);
});
$("[data-promotion-requirements]").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-promotion-requirement]");
  if (button) {
    button.closest(".promotion-requirement-row").remove();
    promotionRequirementsDirty = true;
  }
});

$("[data-promotion-form]").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const editedPromotion = promotions.find(item => item.id === form.elements.id.value);
  const formRequirements = [...form.querySelectorAll(".promotion-requirement-row")].map(row => ({
    matcher: row.querySelector("[data-promotion-matcher]").value,
    value: row.querySelector("[data-promotion-value]").value,
    quantity: Number(row.querySelector("[data-promotion-quantity]").value)
  })).filter(requirement => requirement.value && requirement.quantity > 0);
  const requirements = editedPromotion && !promotionRequirementsDirty
    ? editedPromotion.requirements.map(requirement => ({ ...requirement }))
    : formRequirements;
  if (!requirements.length) return message("[data-promotion-message]", "Agregá al menos un requisito.", true);
  const type = form.elements.promotion_type.value;
  const promotion = {
    id: form.elements.id.value || crypto.randomUUID(),
    name: form.elements.name.value.trim(),
    type,
    price: type === "price" ? Number(form.elements.price.value) : null,
    gift: type === "gift" ? form.elements.gift.value.trim() : null,
    image_url: form.elements.promotion_image_url.value || null,
    priority: Number(form.elements.priority.value || 0),
    startsAt: editedPromotion?.startsAt || null,
    endsAt: editedPromotion?.endsAt || null,
    active: form.elements.active.checked,
    exclusive: form.elements.exclusive.checked,
    requirements
  };
  try {
    const imageFile = editedImages.get(form.elements.promotion_image) || form.elements.promotion_image.files[0];
    if (imageFile) promotion.image_url = await uploadImage(imageFile, "site");
    const index = promotions.findIndex(item => item.id === promotion.id);
    const nextPromotions = index >= 0
      ? promotions.map(item => item.id === promotion.id ? promotion : item)
      : [...promotions, promotion];
    await persistPromotions(index >= 0 ? "Promoción actualizada." : "Promoción creada.", nextPromotions);
    resetPromotionForm();
  } catch (error) {
    message("[data-promotion-message]", error.message, true);
  }
});

$("[data-promotion-list]").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit-promotion]");
  const deleteButton = event.target.closest("[data-delete-promotion]");
  if (editButton) {
    const promotion = promotions.find(item => item.id === editButton.dataset.editPromotion);
    if (!promotion) return;
    const form = $("[data-promotion-form]");
    clearPendingImage(form.elements.promotion_image);
    form.elements.id.value = promotion.id;
    form.elements.name.value = promotion.name;
    form.elements.promotion_type.value = promotion.type || "price";
    form.elements.price.value = promotion.price ?? "";
    form.elements.gift.value = promotion.gift || "";
    form.elements.promotion_image_url.value = promotion.image_url || "";
    renderPendingUploadPreview(form.elements.promotion_image);
    updatePromotionTypeFields();
    form.elements.priority.value = promotion.priority || 0;
    form.elements.active.checked = promotion.active;
    form.elements.exclusive.checked = Boolean(promotion.exclusive);
    renderPromotionRequirements(promotion.requirements);
    promotionRequirementsDirty = false;
    $("[data-promotion-form-title]").textContent = `Editar ${promotion.name}`;
    $("[data-cancel-promotion]").classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (!deleteButton) return;
  const promotion = promotions.find(item => item.id === deleteButton.dataset.deletePromotion);
  if (!promotion || !confirm(`¿Querés eliminar la promoción “${promotion.name}”?`)) return;
  const nextPromotions = promotions.filter(item => item.id !== promotion.id);
  try {
    await persistPromotions("Promoción eliminada.", nextPromotions);
    resetPromotionForm();
  } catch (error) {
    message("[data-promotion-message]", error.message, true);
  }
});

$("[data-cancel-promotion]").addEventListener("click", () => {
  resetPromotionForm();
  message("[data-promotion-message]", "");
});

document.querySelectorAll("[data-content-section-form]").forEach(form => {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const messageElement = form.querySelector("[data-content-message]");
    const sectionMessage = (text, isError = false) => {
      messageElement.textContent = text;
      messageElement.classList.toggle("error", isError);
    };
    sectionMessage("Guardando...");

    if (form.matches("[data-image-settings-form]")) {
      const imageKeys = ["hero_image","editorial_main_image","editorial_small_image"];
      try {
        for (const key of imageKeys) {
          const input = form.elements[`${key}_file`];
          const file = editedImages.get(input) || input.files[0];
          if (file) {
            form.elements[key].value = await uploadImage(file, "site");
          }
        }
      } catch (error) {
        sectionMessage(error.message, true);
        return;
      }
    }

    const records = [...form.elements]
      .filter(element => element.name && !element.name.endsWith("_file") && element.type !== "submit")
      .map(element => ({ key: element.name, value: element.value.trim() }));
    const { error } = await supabase.from("site_content").upsert(records);
    sectionMessage(error ? error.message : "Cambios guardados.", Boolean(error));
  });
});

initAdmin().catch(error => {
  showLogin();
  message("[data-login-message]", error.message, true);
});
