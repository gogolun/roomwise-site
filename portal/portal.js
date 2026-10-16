// Roomwise store portal. Talks straight to Supabase with the public (publishable) key;
// row level security limits each account to its own store and products. Stores start
// hidden and appear in the app once approved.
(() => {
  const SUPABASE_URL = "https://mthxcpaxyzghuvfinwyf.supabase.co";
  const SUPABASE_KEY = "sb_publishable_UwXN6gjMEOJBX4bk5krVNg_gmmETcx4";
  const PHOTO_BUCKET = "listing-photos";
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const PHOTO_MAX_SIDE = 1600; // pixels; plenty for product pages, small to upload
  const SIZE_SUGGESTIONS = ["12 × 12 in", "12 × 24 in", "18 × 18 in", "24 × 24 in", "24 × 48 in", "6 × 36 in",
    "7 × 48 in", "9 × 60 in", "4 × 8 ft", "4 × 12 ft", "8 ft", "16 ft", "30 × 80 in", "32 × 80 in", "36 × 80 in"];

  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const catalog = window.ROOMWISE_CATALOG;
  const productById = new Map(catalog.map((p) => [p.id, p]));
  const $ = (id) => document.getElementById(id);

  let session = null;
  let store = null;
  let listings = [];
  let editing = null; // listing being edited, or null when adding
  let photo = { url: null, file: null };
  let pendingImport = [];
  let signUpMode = false;
  let recovering = false;

  // MARK: Helpers

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function notify(message, isError = false) {
    const notice = $("notice");
    notice.textContent = message;
    notice.classList.toggle("error", isError);
    notice.hidden = !message;
    if (message) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function money(value) {
    return Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function show(viewID) {
    for (const id of ["view-signed-out", "view-new-password", "view-new-store", "view-store"]) {
      $(id).hidden = id !== viewID;
    }
    $("sign-out").hidden = !session || viewID === "view-signed-out";
  }

  function selectTab(buttons, active) {
    for (const button of buttons) button.setAttribute("aria-selected", String(button === active));
  }

  /** "070, 07102, 11" → ["070", "071", "011"]-style three-digit ZIP prefixes. */
  function zipPrefixes(text) {
    const prefixes = (text || "")
      .split(/[\s,;]+/)
      .map((part) => part.replace(/\D/g, ""))
      .filter((digits) => digits.length >= 3)
      .map((digits) => digits.slice(0, 3));
    return [...new Set(prefixes)];
  }

  function friendlyError(error) {
    const message = error?.message || String(error);
    if (/Invalid login credentials/i.test(message)) return "That email and password don't match. Check them, or use “Forgot password?”.";
    if (/already registered/i.test(message)) return "There's already an account with that email. Sign in instead.";
    if (/Email not confirmed/i.test(message)) return "Please confirm your email first: open the link we sent you, then sign in.";
    return message;
  }

  // MARK: Auth

  function setAuthMode(signUp) {
    signUpMode = signUp;
    selectTab([$("tab-sign-in"), $("tab-sign-up")], signUp ? $("tab-sign-up") : $("tab-sign-in"));
    $("auth-submit").textContent = signUp ? "Create account" : "Sign in";
    $("auth-password").autocomplete = signUp ? "new-password" : "current-password";
    $("forgot").hidden = signUp;
  }

  $("tab-sign-in").addEventListener("click", () => setAuthMode(false));
  $("tab-sign-up").addEventListener("click", () => setAuthMode(true));

  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    $("auth-submit").disabled = true;
    notify("");
    try {
      if (signUpMode) {
        const { data, error } = await db.auth.signUp({
          email, password, options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) notify("Check your email for a link to confirm your account, then come back and sign in.");
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (error) {
      notify(friendlyError(error), true);
    } finally {
      $("auth-submit").disabled = false;
    }
  });

  $("forgot").addEventListener("click", async () => {
    const email = $("auth-email").value.trim();
    if (!email) return notify("Type your email above first, then tap “Forgot password?” again.", true);
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    notify(error ? friendlyError(error) : "If there's an account for that email, we've sent a link to reset the password.", !!error);
  });

  $("new-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const { error } = await db.auth.updateUser({ password: $("new-password").value });
    if (error) return notify(friendlyError(error), true);
    recovering = false;
    notify("Password saved.");
    await refresh();
  });

  $("sign-out").addEventListener("click", async () => {
    await db.auth.signOut();
  });

  db.auth.onAuthStateChange((event, newSession) => {
    session = newSession;
    if (event === "PASSWORD_RECOVERY") {
      recovering = true;
      show("view-new-password");
      return;
    }
    // Run outside the callback, as Supabase recommends.
    setTimeout(refresh, 0);
  });

  // MARK: Loading

  async function refresh() {
    if (recovering) return;
    if (!session) {
      store = null;
      show("view-signed-out");
      return;
    }
    const { data, error } = await db.from("retailers").select("*").eq("owner_id", session.user.id).maybeSingle();
    if (error) return notify(friendlyError(error), true);
    store = data;
    if (!store) {
      buildStoreForm($("new-store-form"), null);
      show("view-new-store");
      return;
    }
    renderStoreHeader();
    buildStoreForm($("store-form"), store);
    await loadListings();
    show("view-store");
  }

  async function loadListings() {
    const { data, error } = await db.from("listings").select("*").eq("retailer_id", store.id).order("title");
    if (error) return notify(friendlyError(error), true);
    listings = data;
    renderListings();
  }

  // MARK: Store details

  const storeFields = [
    { key: "name", label: "Store name", required: true, max: 80 },
    { key: "description", label: "About the store", hint: "One or two sentences shoppers will see.", type: "textarea", max: 400 },
    { key: "phone", label: "Phone", type: "tel", required: true, max: 30 },
    { key: "email", label: "Email for customers", type: "email", max: 120 },
    { key: "website", label: "Website", type: "url", placeholder: "https://", max: 200 },
    { key: "address", label: "Street address", required: true, max: 120 },
    { key: "city", label: "City", required: true, max: 60, row: "place" },
    { key: "state", label: "State", required: true, max: 2, placeholder: "NJ", row: "place" },
    { key: "zip", label: "ZIP code", required: true, max: 10, row: "place" },
    { key: "service_zip3", label: "Areas you serve", hint: "ZIP codes or their first three digits, separated by commas. Shoppers in these areas see your store. Leave empty to use your own ZIP code's area.", max: 400 },
  ];

  function buildStoreForm(form, existing) {
    form.replaceChildren();
    let placeRow = null;
    for (const field of storeFields) {
      const id = `store-${field.key}`;
      let value = existing?.[field.key] ?? "";
      if (field.key === "service_zip3") value = (existing?.service_zip3 || []).join(", ");
      const input = field.type === "textarea"
        ? el("textarea", { id, rows: 2, maxlength: field.max })
        : el("input", { id, type: field.type || "text", maxlength: field.max, placeholder: field.placeholder, required: field.required });
      input.value = value;
      const label = el("label", {}, el("span", { class: "label-text" }, field.label, field.required ? null : el("span", { class: "optional", text: " optional" })), input,
        field.hint ? el("span", { class: "hint", text: field.hint }) : null);
      if (field.row === "place") {
        if (!placeRow) {
          placeRow = el("div", { class: "row place-row" });
          form.append(placeRow);
        }
        placeRow.append(label);
      } else {
        form.append(label);
      }
    }
    form.append(el("button", { class: "button primary", type: "submit", text: existing ? "Save changes" : "Send for review" }));
    form.onsubmit = async (event) => {
      event.preventDefault();
      const values = {};
      for (const field of storeFields) {
        const raw = $(`store-${field.key}`).value.trim();
        values[field.key] = raw === "" ? null : raw;
      }
      values.state = values.state?.toUpperCase() ?? null;
      const areas = zipPrefixes(values.service_zip3);
      values.service_zip3 = areas.length ? areas : zipPrefixes(values.zip);
      if (values.website && !/^https?:\/\//i.test(values.website)) values.website = "https://" + values.website;
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      const { error } = existing
        ? await db.from("retailers").update(values).eq("id", existing.id)
        : await db.from("retailers").insert({ ...values, owner_id: session.user.id, kind: "local" });
      button.disabled = false;
      if (error) return notify(friendlyError(error), true);
      notify(existing ? "Store details saved." : "Thanks! Your store is waiting for review. Meanwhile, add your products.");
      await refresh();
    };
  }

  function renderStoreHeader() {
    $("store-name").textContent = store.name;
    const status = $("store-status");
    status.textContent = store.active ? "Live in Roomwise" : "Waiting for review: not shown in Roomwise yet";
    status.className = `status ${store.active ? "live" : "pending"}`;
  }

  // MARK: Tabs

  const storeTabs = [$("tab-products"), $("tab-import"), $("tab-details")];
  const storePanels = { "tab-products": "panel-products", "tab-import": "panel-import", "tab-details": "panel-details" };
  for (const tab of storeTabs) {
    tab.addEventListener("click", () => {
      selectTab(storeTabs, tab);
      for (const [tabID, panelID] of Object.entries(storePanels)) $(panelID).hidden = tabID !== tab.id;
    });
  }

  // MARK: Products

  function coverageText(product, coverage) {
    if (!product || product.measure === "count") return "";
    return `${Number(coverage).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${product.unit}`;
  }

  function renderListings() {
    const list = $("product-list");
    list.replaceChildren();
    $("product-count").textContent = listings.length === 1 ? "1 product" : `${listings.length} products`;
    if (!listings.length) {
      list.append(el("li", { class: "empty" }, "No products yet. Add them one at a time, or import your price list."));
      return;
    }
    for (const listing of listings) {
      const product = productById.get(listing.product_id);
      const thumb = listing.image_url
        ? el("img", { class: "thumb", src: listing.image_url, alt: "" })
        : el("div", { class: "thumb", style: `background:${listing.swatch_hex || "#ddd"}` });
      const coverage = coverageText(product, listing.coverage_per_unit);
      list.append(el("li", {},
        thumb,
        el("div", {},
          el("div", { class: "name" }, listing.title, listing.in_stock ? null : el("span", { class: "badge", text: "Out of stock" })),
          el("div", { class: "meta", text: [product?.name ?? listing.product_id, (listing.specs || []).find((s) => s.name.toLowerCase() === "size")?.value, `${money(listing.unit_price)} per ${listing.unit_name}`, coverage ? `${coverage} each` : null].filter(Boolean).join(" · ") })),
        el("button", { class: "button", onclick: () => openProductDialog(listing) }, "Edit")));
    }
  }

  function fillTypeSelect(select) {
    select.replaceChildren(el("option", { value: "", text: "Choose…" }));
    const groups = new Map();
    for (const product of catalog) {
      if (!groups.has(product.group)) groups.set(product.group, el("optgroup", { label: product.group }));
      groups.get(product.group).append(el("option", { value: product.id, text: `${product.kindTitle}: ${product.name}` }));
    }
    for (const group of groups.values()) select.append(group);
  }
  fillTypeSelect($("p-type"));
  for (const size of SIZE_SUGGESTIONS) $("size-suggestions").append(el("option", { value: size }));

  function addSpecRow(name = "", value = "") {
    const row = el("div", { class: "spec-row" },
      el("input", { placeholder: "e.g. Thickness", maxlength: 60, value: name, "aria-label": "Specification name" }),
      el("input", { placeholder: "e.g. 8 mm", maxlength: 80, value: value, "aria-label": "Specification value" }),
      el("button", { type: "button", class: "link-button", onclick: () => row.remove() }, "Remove"));
    row.children[0].value = name;
    row.children[1].value = value;
    $("p-specs").append(row);
  }
  $("p-add-spec").addEventListener("click", () => addSpecRow());

  function updateCoverageFields(applyDefaults) {
    const product = productById.get($("p-type").value);
    const isCount = product?.measure === "count";
    $("p-coverage-label").hidden = isCount;
    $("p-coverage").required = !isCount;
    $("p-coverage-unit").textContent = product?.unit || "sq ft";
    if (applyDefaults && product) {
      if (isCount) {
        $("p-unit").value = "door";
        $("p-coverage").value = 1;
      } else if (product.pack) {
        $("p-unit").value = product.pack.unit;
        $("p-coverage").value = product.pack.coverage;
      }
    }
    $("p-coverage-unit-name").textContent = $("p-unit").value || "unit";
    updateRate();
  }

  function updateRate() {
    const product = productById.get($("p-type").value);
    const price = parseFloat($("p-price").value);
    const coverage = parseFloat($("p-coverage").value);
    $("p-rate").textContent = product && product.measure !== "count" && price > 0 && coverage > 0
      ? `That's ${money(price / coverage)} per ${product.unit}. Roomwise uses the coverage to work out how many to buy.`
      : "";
  }

  $("p-type").addEventListener("change", () => updateCoverageFields(true));
  $("p-unit").addEventListener("input", () => { $("p-coverage-unit-name").textContent = $("p-unit").value || "unit"; });
  $("p-price").addEventListener("input", updateRate);
  $("p-coverage").addEventListener("input", updateRate);

  function showPhoto(url) {
    $("p-photo-preview").hidden = !url;
    $("p-photo-preview").querySelector("img").src = url || "";
  }

  /** Resizes a photo to at most PHOTO_MAX_SIDE pixels as JPEG, so camera photos upload quickly. */
  async function shrinkPhoto(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("Couldn't read that photo. Try a JPEG or PNG.");
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  }

  async function pickPhoto(input) {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      const small = await shrinkPhoto(file);
      if (small.size > MAX_PHOTO_BYTES) return alert("That photo is too large. Please choose a smaller one.");
      photo = { url: null, file: small };
      showPhoto(URL.createObjectURL(small));
    } catch (error) {
      alert(friendlyError(error));
    }
  }

  $("p-photo").addEventListener("change", () => pickPhoto($("p-photo")));
  $("p-camera").addEventListener("change", () => pickPhoto($("p-camera")));

  $("p-photo-remove").addEventListener("click", () => {
    photo = { url: null, file: null };
    showPhoto(null);
  });

  function openProductDialog(listing) {
    editing = listing;
    $("product-dialog-title").textContent = listing ? "Edit product" : "Add a product";
    $("p-delete").hidden = !listing;
    $("p-type").value = listing?.product_id ?? "";
    $("p-title").value = listing?.title ?? "";
    $("p-brand").value = listing?.brand ?? "";
    $("p-price").value = listing?.unit_price ?? "";
    $("p-unit").value = listing?.unit_name ?? "";
    $("p-coverage").value = listing?.coverage_per_unit ?? "";
    $("p-in-stock").checked = listing?.in_stock ?? true;
    $("p-description").value = listing?.description ?? "";
    $("p-swatch").value = listing?.swatch_hex ?? "#b9b6b1";
    $("p-sku").value = listing?.source_sku ?? "";
    $("p-specs").replaceChildren();
    const specs = listing?.specs ?? [];
    $("p-size").value = specs.find((spec) => spec.name.toLowerCase() === "size")?.value ?? "";
    for (const spec of specs.filter((spec) => spec.name.toLowerCase() !== "size")) addSpecRow(spec.name, spec.value);
    photo = { url: listing?.image_url ?? null, file: null };
    showPhoto(photo.url);
    updateCoverageFields(!listing);
    $("product-dialog").showModal();
  }

  $("add-product").addEventListener("click", () => openProductDialog(null));
  $("p-cancel").addEventListener("click", () => $("product-dialog").close());

  async function uploadPhoto(file) {
    const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${store.id}/${crypto.randomUUID()}.${extension}`;
    const { error } = await db.storage.from(PHOTO_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw error;
    return db.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  $("product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const product = productById.get($("p-type").value);
    if (!product) return alert("Choose the type of product.");
    const save = $("p-save");
    save.disabled = true;
    try {
      let imageURL = photo.url;
      if (photo.file) imageURL = await uploadPhoto(photo.file);
      const size = $("p-size").value.trim();
      const specs = [
        ...(size ? [{ name: "Size", value: size }] : []),
        ...[...$("p-specs").querySelectorAll(".spec-row")]
          .map((row) => ({ name: row.children[0].value.trim(), value: row.children[1].value.trim() }))
          .filter((spec) => spec.name && spec.value && spec.name.toLowerCase() !== "size"),
      ];
      const row = {
        retailer_id: store.id,
        product_id: product.id,
        title: $("p-title").value.trim(),
        brand: $("p-brand").value.trim() || null,
        unit_price: Math.round(parseFloat($("p-price").value) * 100) / 100,
        unit_name: $("p-unit").value.trim(),
        coverage_per_unit: product.measure === "count" ? 1 : parseFloat($("p-coverage").value),
        in_stock: $("p-in-stock").checked,
        description: $("p-description").value.trim() || null,
        image_url: imageURL,
        specs: specs.length ? specs : null,
        swatch_hex: $("p-swatch").value,
        source_sku: $("p-sku").value.trim() || null,
      };
      const { error } = editing
        ? await db.from("listings").update(row).eq("id", editing.id)
        : await db.from("listings").insert(row);
      if (error) throw error;
      $("product-dialog").close();
      notify(editing ? "Product saved." : "Product added.");
      await loadListings();
    } catch (error) {
      alert(friendlyError(error));
    } finally {
      save.disabled = false;
    }
  });

  $("p-delete").addEventListener("click", async () => {
    if (!editing || !confirm(`Delete “${editing.title}”? This can't be undone.`)) return;
    const { error } = await db.from("listings").delete().eq("id", editing.id);
    if (error) return alert(friendlyError(error));
    $("product-dialog").close();
    notify("Product deleted.");
    await loadListings();
  });

  // MARK: Spreadsheet import

  const templateRows = [
    ["type", "title", "size", "brand", "price", "unit", "coverage", "sku", "in_stock", "description", "image_url"],
    ["tile-porcelain", "Porcelain tile, warm beige", "24 x 24 in", "Acme Tile", "39.95", "box", "15.5", "PT-2424-BG", "yes", "Matte porcelain for floors and walls", ""],
    ["floor-lvp", "Waterproof vinyl plank, natural oak", "7 x 48 in", "", "52.40", "box", "20", "LVP-OAK", "yes", "", ""],
  ];
  const typeRows = catalog.map((p) => ["", `# ${p.id} = ${p.kindTitle}: ${p.name}`]);
  const templateCSV = window.Papa.unparse([...templateRows, [], ["# Types you can use in the type column:"], ...typeRows]);
  $("template-link").href = URL.createObjectURL(new Blob([templateCSV], { type: "text/csv" }));

  function findProduct(typeText) {
    const text = (typeText || "").trim().toLowerCase();
    if (!text) return null;
    return catalog.find((p) => p.id === text)
      || catalog.find((p) => p.name.toLowerCase() === text)
      || catalog.find((p) => `${p.kindTitle}: ${p.name}`.toLowerCase() === text)
      || null;
  }

  function parseRow(raw) {
    const get = (key) => String(raw[key] ?? "").trim();
    const problems = [];
    const product = findProduct(get("type"));
    if (!product) problems.push("unknown type");
    const title = get("title");
    if (!title) problems.push("missing title");
    const price = parseFloat(get("price").replace(/[$,]/g, ""));
    if (!(price >= 0)) problems.push("price isn't a number");
    let coverage = parseFloat(get("coverage"));
    if (product?.measure === "count") coverage = 1;
    else if (!(coverage > 0)) coverage = product?.pack?.coverage ?? NaN;
    if (!(coverage > 0)) problems.push("missing coverage");
    const unit = get("unit") || (product?.measure === "count" ? "door" : product?.pack?.unit) || "unit";
    const sku = get("sku") || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
    const imageURL = get("image_url");
    return {
      problems,
      product,
      row: {
        retailer_id: store.id,
        product_id: product?.id,
        title,
        brand: get("brand") || null,
        unit_price: Math.round(price * 100) / 100,
        unit_name: unit,
        coverage_per_unit: coverage,
        in_stock: !/^(no|n|false|0|out)$/i.test(get("in_stock")),
        description: get("description") || null,
        image_url: /^https:\/\//i.test(imageURL) ? imageURL : null,
        specs: get("size") ? [{ name: "Size", value: get("size") }] : null,
        source_sku: sku,
      },
    };
  }

  $("csv-file").addEventListener("change", () => {
    const file = $("csv-file").files[0];
    if (!file) return;
    window.Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.trim().toLowerCase().replace(/\s+/g, "_"),
      complete: (results) => {
        const rows = results.data.filter((raw) => !String(raw.type ?? "").trim().startsWith("#") && String(raw.title ?? raw.type ?? "").trim());
        const parsed = rows.map(parseRow);
        pendingImport = parsed.filter((item) => !item.problems.length).map((item) => item.row);
        renderImportPreview(parsed);
      },
      error: (error) => notify(`Couldn't read that file: ${error.message}`, true),
    });
  });

  function renderImportPreview(parsed) {
    const bad = parsed.filter((item) => item.problems.length).length;
    $("import-summary").textContent = `${pendingImport.length} ready to import${bad ? `, ${bad} with problems (skipped)` : ""}`;
    const table = $("import-table");
    table.replaceChildren(el("tr", {}, ["Type", "Title", "Size", "Price", "Unit", "Covers", "SKU", ""].map((h) => el("th", { text: h }))));
    for (const item of parsed) {
      table.append(el("tr", {},
        el("td", { text: item.product ? item.product.kindTitle : "?" }),
        el("td", { text: item.row.title }),
        el("td", { text: item.row.specs?.[0]?.value ?? "" }),
        el("td", { text: Number.isFinite(item.row.unit_price) ? money(item.row.unit_price) : "?" }),
        el("td", { text: item.row.unit_name }),
        el("td", { text: item.product ? coverageText(item.product, item.row.coverage_per_unit) || "1" : "" }),
        el("td", { text: item.row.source_sku }),
        el("td", { class: item.problems.length ? "problem" : "", text: item.problems.join(", ") || "✓" })));
    }
    $("import-confirm").disabled = !pendingImport.length;
    $("import-preview").hidden = false;
  }

  $("import-confirm").addEventListener("click", async () => {
    const button = $("import-confirm");
    button.disabled = true;
    const { error } = await db.from("listings").upsert(pendingImport, { onConflict: "retailer_id,source_sku" });
    button.disabled = false;
    if (error) return notify(friendlyError(error), true);
    notify(`Imported ${pendingImport.length} products.`);
    pendingImport = [];
    $("import-preview").hidden = true;
    $("csv-file").value = "";
    await loadListings();
    $("tab-products").click();
  });

  // MARK: Scan price tags

  const MAX_SCAN_PHOTOS = 4;
  let scanPhotos = []; // { file, url }
  let scanRows = [];   // drafts from the photos, edited in the table

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function renderScanThumbs() {
    const thumbs = $("scan-thumbs");
    thumbs.replaceChildren(...scanPhotos.map((photo, index) => el("figure", {},
      el("img", { src: photo.url, alt: `Photo ${index + 1}` }),
      el("button", { type: "button", "aria-label": "Remove photo", onclick: () => {
        scanPhotos.splice(index, 1);
        renderScanThumbs();
      } }, "×"))));
    $("scan-read").disabled = scanPhotos.length === 0;
    $("scan-status").textContent = scanPhotos.length
      ? `${scanPhotos.length} of ${MAX_SCAN_PHOTOS} photos. Add more, or read them.`
      : "";
  }

  async function addScanPhotos(input) {
    const files = [...input.files];
    input.value = "";
    for (const file of files) {
      if (scanPhotos.length >= MAX_SCAN_PHOTOS) {
        alert(`Up to ${MAX_SCAN_PHOTOS} photos at a time. Read these first, then scan more.`);
        break;
      }
      try {
        const small = await shrinkPhoto(file);
        scanPhotos.push({ file: small, url: URL.createObjectURL(small) });
      } catch (error) {
        alert(friendlyError(error));
      }
    }
    renderScanThumbs();
  }

  function openScanDialog() {
    scanPhotos = [];
    scanRows = [];
    $("scan-review").hidden = true;
    $("scan-add").hidden = true;
    $("scan-read").hidden = false;
    renderScanThumbs();
    $("scan-dialog").showModal();
  }

  $("scan-tags").addEventListener("click", openScanDialog);
  $("scan-camera").addEventListener("change", () => addScanPhotos($("scan-camera")));
  $("scan-library").addEventListener("change", () => addScanPhotos($("scan-library")));
  $("scan-cancel").addEventListener("click", () => $("scan-dialog").close());

  /** The product types, in the compact form the reader needs. */
  function catalogForScan() {
    return catalog.map((p) => ({
      id: p.id, name: p.name, kindTitle: p.kindTitle, unit: p.unit,
      packUnit: p.pack?.unit, packCoverage: p.pack?.coverage,
    }));
  }

  async function functionError(error) {
    // Supabase wraps non-2xx replies; the function's own message is in the body.
    try {
      const body = await error.context.json();
      if (body?.error) return body.error;
    } catch {}
    return friendlyError(error);
  }

  $("scan-read").addEventListener("click", async () => {
    const button = $("scan-read");
    button.disabled = true;
    $("scan-status").textContent = "Reading the photos… this takes about 10 to 30 seconds.";
    try {
      const images = await Promise.all(scanPhotos.map(async (photo) => ({
        mediaType: "image/jpeg", data: await blobToBase64(photo.file),
      })));
      const { data, error } = await db.functions.invoke("extract-products", { body: { images, catalog: catalogForScan() } });
      if (error) throw new Error(await functionError(error));
      scanRows = (data.products || []).map((product) => ({ ...product, include: product.type !== "other" }));
      if (!scanRows.length) {
        $("scan-status").textContent = data.message || "No products could be read. Try a closer, sharper photo of the tags.";
        button.disabled = false;
        return;
      }
      $("scan-status").textContent = `Found ${scanRows.length} ${scanRows.length === 1 ? "product" : "products"}. ${data.message || ""}`;
      renderScanTable();
      $("scan-review").hidden = false;
      $("scan-read").hidden = true;
      $("scan-add").hidden = false;
    } catch (error) {
      $("scan-status").textContent = error.message || String(error);
      button.disabled = false;
    }
  });

  function scanInput(row, key, props = {}) {
    const input = el("input", { ...props, "aria-label": key });
    input.value = row[key] ?? "";
    input.addEventListener("input", () => {
      row[key] = props.type === "number" ? parseFloat(input.value) : input.value;
    });
    return input;
  }

  function renderScanTable() {
    const table = $("scan-table");
    table.replaceChildren(el("tr", {}, ["Add", "Type", "Name", "Size", "Price ($)", "Sold by", "Covers", "Code", "Check"].map((h) => el("th", { text: h }))));
    for (const row of scanRows) {
      const include = el("input", { type: "checkbox", "aria-label": "Add this product" });
      include.checked = row.include;
      include.addEventListener("change", () => { row.include = include.checked; });
      const type = el("select", { "aria-label": "Type" });
      fillTypeSelect(type);
      type.value = row.type === "other" ? "" : row.type;
      type.addEventListener("change", () => { row.type = type.value || "other"; });
      const unitName = productById.get(row.type)?.unit;
      row.tr = el("tr", { class: row.confidence === "low" ? "low" : "" },
        el("td", {}, include),
        el("td", {}, type),
        el("td", {}, scanInput(row, "title", { class: "title", maxlength: 140 })),
        el("td", {}, scanInput(row, "size", { class: "short", maxlength: 40, list: "size-suggestions" })),
        el("td", {}, scanInput(row, "price", { class: "num", type: "number", min: 0, step: "0.01" })),
        el("td", {}, scanInput(row, "unit", { class: "short", maxlength: 30 })),
        el("td", {}, scanInput(row, "coverage", { class: "num", type: "number", min: 0, step: "0.01", title: unitName ? `${unitName} per unit` : "" })),
        el("td", {}, scanInput(row, "sku", { class: "short", maxlength: 80 })),
        el("td", { class: "note", text: [row.confidence === "low" ? "Check carefully." : "", row.type === "other" ? "Choose a type." : "", row.note].filter(Boolean).join(" ") }));
      table.append(row.tr);
    }
  }

  $("scan-add").addEventListener("click", async () => {
    const chosen = scanRows.filter((row) => row.include);
    if (!chosen.length) return alert("Tick at least one product to add.");
    const rows = [];
    let problems = 0;
    for (const row of chosen) {
      const product = productById.get(row.type);
      const price = Number(row.price);
      const coverage = product?.measure === "count" ? 1 : Number(row.coverage) || product?.pack?.coverage || 0;
      const ok = product && String(row.title).trim() && price > 0 && coverage > 0;
      row.tr.classList.toggle("error", !ok);
      if (!ok) { problems += 1; continue; }
      const title = String(row.title).trim();
      const size = String(row.size || "").trim();
      rows.push({
        retailer_id: store.id,
        product_id: product.id,
        title,
        brand: String(row.brand || "").trim() || null,
        unit_price: Math.round(price * 100) / 100,
        unit_name: String(row.unit || "").trim() || product.pack?.unit || "unit",
        coverage_per_unit: coverage,
        in_stock: true,
        specs: size ? [{ name: "Size", value: size }] : null,
        source_sku: String(row.sku || "").trim() || `${title} ${size}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80),
      });
    }
    if (problems) return alert(`${problems} ticked ${problems === 1 ? "product needs" : "products need"} a type, a name, a price and what one unit covers (highlighted in red).`);
    const button = $("scan-add");
    button.disabled = true;
    const { error } = await db.from("listings").upsert(rows, { onConflict: "retailer_id,source_sku" });
    button.disabled = false;
    if (error) return alert(friendlyError(error));
    $("scan-dialog").close();
    notify(`Added ${rows.length} ${rows.length === 1 ? "product" : "products"} from your photos. Open any of them to add a product photo or details.`);
    await loadListings();
  });

  setAuthMode(false);
})();
