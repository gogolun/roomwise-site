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

  // An invitation link arrives with "type=invite" in the address; read it before
  // Supabase signs the user in and clears it, so we can ask them for a password.
  const arrivedFromInvite = new URLSearchParams(location.hash.slice(1)).get("type") === "invite";
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
  let askedInvitePassword = false;
  // Admins see every store; managedStoreID is the store they've opened, and
  // creatingForShop is set while they add a store on a shop's behalf.
  let isAdmin = false;
  let managedStoreID = null;
  let creatingForShop = false;

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
    for (const id of ["view-signed-out", "view-new-password", "view-new-store", "view-store", "view-admin"]) {
      $(id).hidden = id !== viewID;
    }
    $("sign-out").hidden = !session || viewID === "view-signed-out";
    $("change-password").hidden = !session || viewID === "view-signed-out" || viewID === "view-new-password";
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

  $("tab-sign-in").addEventListener("click", () => { setAuthMode(false); authMessage(""); });
  $("tab-sign-up").addEventListener("click", () => { setAuthMode(true); authMessage(""); });

  /** Puts a button into its working state ("Creating account…" with a spinner) and back. */
  function setBusy(button, busyText) {
    if (busyText) {
      button.dataset.label = button.textContent;
      button.textContent = busyText;
      button.classList.add("busy");
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.classList.remove("busy");
      button.disabled = false;
    }
  }

  /** A message inside the sign-in box, so nothing jumps to the top of the page. */
  function authMessage(text, isError = false) {
    const message = $("auth-message");
    message.textContent = text;
    message.classList.toggle("error", isError);
    message.hidden = !text;
  }

  function showSent(email) {
    $("auth-sent-email").textContent = email;
    $("auth-form").hidden = true;
    document.querySelector(".auth-card .segmented").hidden = true;
    $("auth-sent").hidden = false;
  }

  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const button = $("auth-submit");
    setBusy(button, signUpMode ? "Creating account…" : "Signing in…");
    authMessage("");
    notify("");
    try {
      if (signUpMode) {
        const { data, error } = await db.auth.signUp({
          email, password, options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) showSent(email);
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (error) {
      authMessage(friendlyError(error), true);
    } finally {
      setBusy(button, null);
    }
  });

  $("auth-resend").addEventListener("click", async () => {
    const button = $("auth-resend");
    setBusy(button, "Sending…");
    const { error } = await db.auth.resend({
      type: "signup", email: $("auth-sent-email").textContent,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    setBusy(button, null);
    button.textContent = error ? "Couldn't send. Try again" : "Sent ✓";
    if (error) alert(friendlyError(error));
  });

  $("auth-different").addEventListener("click", () => {
    $("auth-sent").hidden = true;
    $("auth-form").hidden = false;
    document.querySelector(".auth-card .segmented").hidden = false;
    $("auth-resend").textContent = "Send the link again";
    $("auth-email").focus();
  });

  $("forgot").addEventListener("click", async () => {
    const email = $("auth-email").value.trim();
    if (!email) return authMessage("Type your email above first, then tap “Forgot password?” again.", true);
    const button = $("forgot");
    setBusy(button, "Sending…");
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    setBusy(button, null);
    authMessage(error ? friendlyError(error) : "If there's an account for that email, we've sent a link to reset the password.", !!error);
  });

  /** Shows the password form: after an invitation, a reset link, or "Change password". */
  function askForPassword(mode) {
    recovering = true;
    const titles = {
      invite: ["Welcome! Choose a password", "You'll use it with this email to sign in to the Roomwise store portal."],
      reset: ["Choose a new password", ""],
      change: ["Change your password", ""],
    };
    $("new-password-title").textContent = titles[mode][0];
    $("new-password-intro").textContent = titles[mode][1];
    $("new-password-intro").hidden = !titles[mode][1];
    $("new-password-cancel").hidden = mode !== "change";
    $("new-password").value = "";
    show("view-new-password");
  }

  $("change-password").addEventListener("click", () => askForPassword("change"));
  $("new-password-cancel").addEventListener("click", async () => {
    recovering = false;
    await refresh();
  });

  $("new-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const { error } = await db.auth.updateUser({ password: $("new-password").value });
    if (error) return notify(friendlyError(error), true);
    recovering = false;
    notify("Password saved. Use it with your email to sign in next time.");
    await refresh();
  });

  $("sign-out").addEventListener("click", async () => {
    managedStoreID = null;
    creatingForShop = false;
    await db.auth.signOut();
  });

  db.auth.onAuthStateChange((event, newSession) => {
    session = newSession;
    if (event === "PASSWORD_RECOVERY") {
      askForPassword("reset");
      return;
    }
    if (arrivedFromInvite && newSession && !askedInvitePassword) {
      askedInvitePassword = true;
      setTimeout(() => askForPassword("invite"), 0);
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
    const admin = await db.rpc("is_admin");
    isAdmin = admin.data === true;
    if (isAdmin && !managedStoreID) {
      if (creatingForShop) return showNewStore();
      return loadAdmin();
    }
    const query = isAdmin
      ? db.from("retailers").select("*").eq("id", managedStoreID).maybeSingle()
      : db.from("retailers").select("*").eq("owner_id", session.user.id).maybeSingle();
    const { data, error } = await query;
    if (error) return notify(friendlyError(error), true);
    store = data;
    if (!store) {
      if (isAdmin) {
        managedStoreID = null;
        return loadAdmin();
      }
      return showNewStore();
    }
    renderStoreHeader();
    buildStoreForm($("store-form"), store);
    await loadListings();
    show("view-store");
  }

  function showNewStore() {
    $("new-store-back").hidden = !isAdmin;
    $("new-store-title").textContent = isAdmin ? "Add a store for a shop" : "Tell us about your store";
    $("new-store-intro").textContent = isAdmin
      ? "You'll manage it until the shop takes it over: add products for them, then invite the owner using the email below."
      : "Shoppers see this in Roomwise. We review new stores before they appear, usually within two business days.";
    buildStoreForm($("new-store-form"), null);
    show("view-new-store");
  }

  // MARK: Admin

  async function loadAdmin() {
    store = null;
    const [stores, products] = await Promise.all([
      db.from("retailers").select("*").eq("kind", "local").order("created_at", { ascending: false }),
      db.from("listings").select("retailer_id"),
    ]);
    if (stores.error) return notify(friendlyError(stores.error), true);
    const counts = new Map();
    for (const row of products.data ?? []) counts.set(row.retailer_id, (counts.get(row.retailer_id) ?? 0) + 1);
    const list = $("admin-store-list");
    list.replaceChildren();
    const pending = stores.data.filter((s) => !s.active).length;
    $("admin-summary").textContent = `${stores.data.length} ${stores.data.length === 1 ? "store" : "stores"}${pending ? `, ${pending} waiting for review` : ""}`;
    if (!stores.data.length) list.append(el("li", { class: "empty" }, "No stores yet."));
    for (const s of stores.data) {
      const count = counts.get(s.id) ?? 0;
      const place = [s.city, s.state].filter(Boolean).join(", ");
      list.append(el("li", {},
        el("div", {},
          el("div", { class: "name" }, s.name, el("span", { class: `status ${s.active ? "live" : "pending"}`, text: s.active ? "Live" : "Hidden" })),
          el("div", { class: "meta", text: [place, `${count} ${count === 1 ? "product" : "products"}`, s.owner_id ? "owner has an account" : (s.email ? `no account yet · ${s.email}` : "no account yet")].filter(Boolean).join(" · ") })),
        el("button", { class: "button", onclick: () => manage(s.id) }, "Manage")));
    }
    show("view-admin");
  }

  async function manage(storeID) {
    managedStoreID = storeID;
    creatingForShop = false;
    notify("");
    await refresh();
  }

  function backToAllStores() {
    managedStoreID = null;
    creatingForShop = false;
    notify("");
    refresh();
  }

  $("admin-add-store").addEventListener("click", () => {
    creatingForShop = true;
    notify("");
    showNewStore();
  });
  $("store-back").addEventListener("click", backToAllStores);
  $("new-store-back").addEventListener("click", backToAllStores);

  $("admin-toggle").addEventListener("click", async () => {
    const { error } = await db.from("retailers").update({ active: !store.active }).eq("id", store.id);
    if (error) return notify(friendlyError(error), true);
    notify(store.active ? "Store hidden from Roomwise." : "Store approved: it now appears in Roomwise.");
    await refresh();
  });

  $("admin-invite").addEventListener("click", async () => {
    if (!store.email) return notify("Add the shop's email under Store details first.", true);
    if (!confirm(`Give this store to ${store.email}? If they have no account yet, they'll get an invitation email.`)) return;
    const { data, error } = await db.functions.invoke("admin-invite", { body: { retailerId: store.id } });
    if (error) return notify(await functionError(error), true);
    notify(data.message);
    await refresh();
  });

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
      if (!existing && isAdmin && !values.email) {
        button.disabled = false;
        return notify("Add the shop's email so you can invite them later.", true);
      }
      let error;
      if (existing) {
        ({ error } = await db.from("retailers").update(values).eq("id", existing.id));
      } else if (isAdmin) {
        // A store for a shop: no owner yet, hidden until approved.
        const created = await db.from("retailers").insert({ ...values, kind: "local", active: false }).select("id").single();
        error = created.error;
        if (!error) {
          managedStoreID = created.data.id;
          creatingForShop = false;
        }
      } else {
        ({ error } = await db.from("retailers").insert({ ...values, owner_id: session.user.id, kind: "local" }));
      }
      button.disabled = false;
      if (error) return notify(friendlyError(error), true);
      notify(existing ? "Store details saved."
        : isAdmin ? "Store created. Add its products, then approve it and invite the owner."
        : "Thanks! Your store is waiting for review. Meanwhile, add your products.");
      await refresh();
    };
  }

  function renderStoreHeader() {
    $("store-name").textContent = store.name;
    $("store-back").hidden = !isAdmin;
    $("admin-bar").hidden = !isAdmin;
    if (isAdmin) {
      const own = store.owner_id === session.user.id;
      $("admin-owner").textContent = own ? "This is your own store."
        : store.owner_id ? "The shop owner has an account and manages this store too."
        : `No owner account yet. Shop email: ${store.email || "not set"}.`;
      $("admin-invite").hidden = !!store.owner_id;
      $("admin-toggle").textContent = store.active ? "Hide from Roomwise" : "Approve: show in Roomwise";
      $("admin-toggle").classList.toggle("primary", !store.active);
    }
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
  let scanMode = "photos"; // or "website"
  let foundStore = [];  // store details read from the website: { key, label, value, include }

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
    if (scanMode !== "photos") return;
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

  function openScanDialog(mode) {
    scanMode = mode;
    scanPhotos = [];
    scanRows = [];
    foundStore = [];
    const web = mode === "website";
    $("scan-title").textContent = web ? "Import from your website" : "Scan price tags";
    $("scan-photo-part").hidden = web;
    $("scan-web-part").hidden = !web;
    $("scan-store").hidden = true;
    $("scan-review").hidden = true;
    $("scan-add").hidden = true;
    const read = $("scan-read");
    read.hidden = false;
    read.textContent = web ? "Read my website" : "Read the photos";
    $("scan-status").textContent = "";
    if (web) {
      $("scan-url").value = store.website || "";
      read.disabled = !$("scan-url").value.trim();
    }
    renderScanThumbs();
    $("scan-dialog").showModal();
  }

  $("scan-tags").addEventListener("click", () => openScanDialog("photos"));
  $("import-website").addEventListener("click", () => openScanDialog("website"));
  $("details-from-website").addEventListener("click", () => openScanDialog("website"));
  $("scan-url").addEventListener("input", () => { $("scan-read").disabled = !$("scan-url").value.trim(); });
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
    const web = scanMode === "website";
    setBusy(button, "Reading…");
    $("scan-status").textContent = web
      ? "Reading your website… this can take a minute or two. Keep this page open."
      : "Reading the photos… this takes about 10 to 30 seconds.";
    try {
      let data, error;
      if (web) {
        ({ data, error } = await db.functions.invoke("import-website", {
          body: { retailerId: store.id, url: $("scan-url").value.trim(), catalog: catalogForScan() },
        }));
      } else {
        const images = await Promise.all(scanPhotos.map(async (photo) => ({
          mediaType: "image/jpeg", data: await blobToBase64(photo.file),
        })));
        ({ data, error } = await db.functions.invoke("extract-products", {
          body: { retailerId: store.id, images, catalog: catalogForScan() },
        }));
      }
      if (error) throw new Error(await functionError(error));
      scanRows = (data.products || []).map((product) => ({ ...product, include: product.type !== "other" }));
      foundStore = web ? storeChanges(data.store) : [];
      setBusy(button, null);
      if (!scanRows.length && !foundStore.length) {
        $("scan-status").textContent = data.message
          || (web ? "Nothing new was found on that site. Try the address of the page that lists your products."
            : "No products could be read. Try a closer, sharper photo of the tags.");
        return;
      }
      const found = [];
      if (scanRows.length) found.push(`${scanRows.length} ${scanRows.length === 1 ? "product" : "products"}`);
      if (foundStore.length) found.push("store details");
      $("scan-status").textContent = `Found ${found.join(" and ")}. ${data.message || ""}`;
      renderFoundStore();
      $("scan-review").hidden = !scanRows.length;
      if (scanRows.length) renderScanTable();
      button.hidden = true;
      $("scan-add").hidden = false;
    } catch (error) {
      setBusy(button, null);
      $("scan-status").textContent = error.message || String(error);
    }
  });

  /** Details from the website that differ from the store's. Empty fields are ticked to fill. */
  function storeChanges(found) {
    if (!found) return [];
    const changes = [];
    for (const field of storeFields) {
      let value = String(found[field.key] ?? "").trim().slice(0, field.max);
      if (field.key === "state") value = value.toUpperCase();
      if (!value || field.key === "service_zip3") continue;
      const current = String(store[field.key] ?? "").trim();
      if (current.toLowerCase() === value.toLowerCase()) continue;
      changes.push({ key: field.key, label: field.label, value, current, include: !current });
    }
    return changes;
  }

  function renderFoundStore() {
    $("scan-store").hidden = !foundStore.length;
    $("scan-store-fields").replaceChildren(...foundStore.map((change) => {
      const box = el("input", { type: "checkbox" });
      box.checked = change.include;
      box.addEventListener("change", () => { change.include = box.checked; });
      return el("li", {}, el("label", {}, box, el("span", {},
        el("b", { text: `${change.label}: ` }), change.value,
        change.current ? el("span", { class: "was", text: `Replaces: ${change.current}` }) : null)));
    }));
  }

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
    const photos = scanRows.some((row) => row.image_url);
    table.replaceChildren(el("tr", {}, ["Add", photos ? "Photo" : null, "Type", "Name", "Size", "Price ($)", "Sold by", "Covers", "Code", "Check"]
      .filter(Boolean).map((h) => el("th", { text: h }))));
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
        photos ? el("td", {}, row.image_url ? el("img", { class: "thumb", src: row.image_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null) : null,
        el("td", {}, type),
        el("td", {}, scanInput(row, "title", { class: "title", maxlength: 140 })),
        el("td", {}, scanInput(row, "size", { class: "short", maxlength: 40, list: "size-suggestions" })),
        el("td", {}, scanInput(row, "price", { class: "num", type: "number", min: 0, step: "0.01" })),
        el("td", {}, scanInput(row, "unit", { class: "short", maxlength: 30 })),
        el("td", {}, scanInput(row, "coverage", { class: "num", type: "number", min: 0, step: "0.01", title: unitName ? `${unitName} per unit` : "" })),
        el("td", {}, scanInput(row, "sku", { class: "short", maxlength: 80 })),
        el("td", { class: "note" },
          [row.confidence === "low" ? "Check carefully." : "", row.type === "other" ? "Choose a type." : "", row.note].filter(Boolean).join(" "),
          row.url ? el("a", { href: row.url, target: "_blank", rel: "noopener noreferrer", text: " View on your site" }) : null));
      table.append(row.tr);
    }
  }

  $("scan-add").addEventListener("click", async () => {
    const chosen = scanRows.filter((row) => row.include);
    const details = foundStore.filter((change) => change.include);
    if (!chosen.length && !details.length) return alert("Tick at least one product or store detail to add.");
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
      const sku = String(row.sku || "").trim() || `${title} ${size}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
      // From a website: the product page, photo and description, keeping any photo or
      // description the store already added itself.
      const existing = listings.find((listing) => listing.source_sku === sku);
      const fromSite = scanMode === "website" ? {
        url: row.url || existing?.url || null,
        image_url: existing?.image_url || row.image_url || null,
        description: existing?.description || String(row.description || "").trim() || null,
      } : {};
      rows.push({
        ...fromSite,
        retailer_id: store.id,
        product_id: product.id,
        title,
        brand: String(row.brand || "").trim() || null,
        unit_price: Math.round(price * 100) / 100,
        unit_name: String(row.unit || "").trim() || product.pack?.unit || "unit",
        coverage_per_unit: coverage,
        in_stock: true,
        specs: size ? [{ name: "Size", value: size }] : null,
        source_sku: sku,
      });
    }
    if (problems) return alert(`${problems} ticked ${problems === 1 ? "product needs" : "products need"} a type, a name, a price and what one unit covers (highlighted in red).`);
    const button = $("scan-add");
    setBusy(button, "Saving…");
    if (details.length) {
      const values = Object.fromEntries(details.map((change) => [change.key, change.value]));
      const { data, error } = await db.from("retailers").update(values).eq("id", store.id).select("*").single();
      if (error) {
        setBusy(button, null);
        return alert(friendlyError(error));
      }
      store = data;
      foundStore = foundStore.filter((change) => !change.include);
      renderFoundStore();
      renderStoreHeader();
      buildStoreForm($("store-form"), store);
    }
    if (rows.length) {
      const { error } = await db.from("listings").upsert(rows, { onConflict: "retailer_id,source_sku" });
      if (error) {
        setBusy(button, null);
        return alert(friendlyError(error));
      }
    }
    setBusy(button, null);
    $("scan-dialog").close();
    const source = scanMode === "website" ? "your website" : "your photos";
    const done = [];
    if (rows.length) done.push(`Added ${rows.length} ${rows.length === 1 ? "product" : "products"}`);
    if (details.length) done.push(`${rows.length ? "updated" : "Updated"} your store details`);
    notify(`${done.join(" and ")} from ${source}.${rows.length ? " Open any product to add a photo or details." : ""}`);
    await loadListings();
  });

  setAuthMode(false);
})();
