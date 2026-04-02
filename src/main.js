console.log("🔥 main.js loaded");

import "./style.css";
import appHtml from "./app.html?raw";

// 1) 把 UI 打進 #app
document.querySelector("#app").innerHTML = appHtml;

// 2) Firebase
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as analyticsSupported } from "firebase/analytics";
import {
  getFirestore,
  collection,
  collectionGroup,
  addDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  writeBatch,
  startAfter,
  doc,
  setDoc
} from "firebase/firestore";

import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";

/* =======================
   Firebase Config
======================= */
const firebaseConfig = {
  apiKey: "AIzaSyD9bdDtq3BWDt9P_e4Uw8DftbThDNT1RsE",
  authDomain: "talk-2114b.firebaseapp.com",
  projectId: "talk-2114b",
  storageBucket: "talk-2114b.firebasestorage.app",
  messagingSenderId: "374632969029",
  appId: "1:374632969029:web:3d10fb1077796a237c842c",
  measurementId: "G-FBVL3RY2GJ"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const apiParam = new URLSearchParams(window.location.search).get("api");

if (apiParam) {
  localStorage.setItem("chatAdminApiBaseUrl", apiParam);
}

const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const storedApiBase = localStorage.getItem("chatAdminApiBaseUrl");
const DEFAULT_PRODUCTION_API_BASE = "https://talk2-admin-api.onrender.com";
const API_BASE = (isLocalHost ? "" : (storedApiBase || import.meta.env.VITE_API_BASE_URL || DEFAULT_PRODUCTION_API_BASE)).replace(/\/$/, "");

async function verifyAdminPassword(password){
  if (!API_BASE && !isLocalHost) {
    throw new Error("ADMIN_API_NOT_CONFIGURED");
  }

  const response = await fetch(`${API_BASE}/api/admin/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || "ADMIN_PASSWORD_VERIFY_FAILED");
  }

  return data;
}

// Analytics：某些環境不支援就跳過
analyticsSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {});

/* =======================
   Admin whitelist
   - 只有這些 UID 才算白名單管理員（能刪除）
======================= */
const ADMIN_UIDS = new Set([
  "3iOaPxm6wbSbrSRi6BV9ghIvY7a2",
  "sOCJOr8c8JdmkTyNEbRBt5f6jw43"
]);

/* =======================
   Auth bootstrap
======================= */
let authReadyResolve;
const authReady = new Promise((res) => (authReadyResolve = res));

onAuthStateChanged(auth, (u) => {
  if (u) authReadyResolve(u);
});

// 客戶：匿名登入（保持不變）
async function ensureSignedIn() {
  const u = auth.currentUser;
  if (u) {
    console.log("AUTH UID =", u.uid);
    return u;
  }
  await signInAnonymously(auth);
  const user = await authReady;
  console.log("AUTH UID =", user.uid);
  return user;
}

// 管理員：必須 Email/Password 登入 + UID 白名單檢查
async function ensureAdminSignedIn() {
  const cur = auth.currentUser;
  if (cur && ADMIN_UIDS.has(cur.uid)) {
    console.log("ADMIN AUTH UID =", cur.uid);
    return cur;
  }

  const email = prompt("管理員 Email");
  const password = prompt("管理員 Password");
  if (!email || !password) throw new Error("ADMIN_CREDENTIALS_MISSING");

  await signInWithEmailAndPassword(auth, email, password);

  const u = auth.currentUser;
  console.log("ADMIN AUTH UID =", u?.uid);

  if (!u || !ADMIN_UIDS.has(u.uid)) {
    await signOut(auth);
    throw new Error("NOT_WHITELISTED_ADMIN");
  }

  return u;
}

/* =======================
   Utilities
======================= */
function sanitizeRoom(r){ return (r || "").trim().replace(/\s+/g, "").slice(0, 32); }
function sanitizeName(n){ return (n || "").trim().slice(0, 20); }
function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
function fmtTime(ts){
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function initials(s){
  const t = (s||"").trim();
  return t ? t.slice(0,2).toUpperCase() : "客";
}
function setHidden(el, hidden){
  if(hidden) el.classList.add("hidden");
  else el.classList.remove("hidden");
}
function loadJSON(key, fallback){
  try{
    const v = localStorage.getItem(key);
    if(!v) return fallback;
    return JSON.parse(v);
  }catch(e){
    return fallback;
  }
}
function saveJSON(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

// ✅ 建房間文件（你的 rules 允許 create/update；這只是讓 rooms/{roomId} 存在）
async function ensureRoomDoc(roomId){
  await ensureSignedIn();
  const roomRef = doc(db, "rooms", roomId);
  await setDoc(roomRef, { createdAt: Date.now() }, { merge: true });
}

/* =======================
   Global State
======================= */
let mode = "none"; // none | customer | admin

let customerRoom = "";
let customerName = "";
let customerUnsubRoom = null;
let customerLastSeen = loadJSON("customerLastSeenByRoom", {}); // {room: ts}

let adminSelectedRoom = "";
let adminUnsubRoom = null;
let adminUnsubRecent = null;
let adminRoomsMap = new Map();
let adminLastSeen = loadJSON("adminLastSeenByRoom", {}); // {room: ts}

/* =======================
   DOM
======================= */
const roleCard = document.getElementById("roleCard");
const adminLoginCard = document.getElementById("adminLoginCard");

const goCustomerBtn = document.getElementById("goCustomerBtn");
const goAdminBtn = document.getElementById("goAdminBtn");

const adminPassInput = document.getElementById("adminPassInput");
const adminEnterBtn = document.getElementById("adminEnterBtn");
const backToRoleFromAdmin = document.getElementById("backToRoleFromAdmin");

// customer shell
const customerShell = document.getElementById("customerShell");
const customerExitBtn = document.getElementById("customerExitBtn");
const customerChatList = document.getElementById("customerChatList");
const customerRoomTitle = document.getElementById("customerRoomTitle");
const customerRoomSub = document.getElementById("customerRoomSub");
const customerThread = document.getElementById("customerThread");
const customerForm = document.getElementById("customerForm");
const customerInput = document.getElementById("customerInput");
const customerMarkReadBtn = document.getElementById("customerMarkReadBtn");
const customerChangeRoomBtn = document.getElementById("customerChangeRoomBtn");

// admin shell
const adminShell = document.getElementById("adminShell");
const adminExitBtn = document.getElementById("adminExitBtn");
const adminSearch = document.getElementById("adminSearch");
const adminChatList = document.getElementById("adminChatList");
const adminRoomTitle = document.getElementById("adminRoomTitle");
const adminRoomSub = document.getElementById("adminRoomSub");
const adminThread = document.getElementById("adminThread");
const adminForm = document.getElementById("adminForm");
const adminInput = document.getElementById("adminInput");
const adminNewRoomBtn = document.getElementById("adminNewRoomBtn");
const adminMarkReadBtn = document.getElementById("adminMarkReadBtn");
const adminCopyRoomBtn = document.getElementById("adminCopyRoomBtn");
const adminDeleteRoomBtn = document.getElementById("adminDeleteRoomBtn");

/* =======================
   Navigation
======================= */
function showRole(){
  mode="none";
  setHidden(roleCard, false);
  setHidden(adminLoginCard, true);
  setHidden(customerShell, true);
  setHidden(adminShell, true);
}
function showAdminLogin(){
  mode="none";
  setHidden(roleCard, true);
  setHidden(adminLoginCard, false);
  setHidden(customerShell, true);
  setHidden(adminShell, true);
}
function showCustomer(){
  mode="customer";
  setHidden(roleCard, true);
  setHidden(adminLoginCard, true);
  setHidden(customerShell, false);
  setHidden(adminShell, true);
}
function showAdmin(){
  mode="admin";
  setHidden(roleCard, true);
  setHidden(adminLoginCard, true);
  setHidden(customerShell, true);
  setHidden(adminShell, false);
}
async function leaveAll(){
  if(customerUnsubRoom){ customerUnsubRoom(); customerUnsubRoom=null; }
  if(adminUnsubRoom){ adminUnsubRoom(); adminUnsubRoom=null; }
  if(adminUnsubRecent){ adminUnsubRecent(); adminUnsubRecent=null; }

  customerThread.innerHTML = "";
  customerChatList.innerHTML = "";
  adminThread.innerHTML = "";
  adminChatList.innerHTML = "";

  adminSelectedRoom = "";
  customerRoom = "";
  customerName = "";

  // 登出（避免 admin/客戶身份混著用）
  try{ await signOut(auth); }catch{}

  showRole();
}

/* =======================
   Home actions
======================= */
goCustomerBtn.onclick = async () => {
  const last = loadJSON("lastCustomerProfile", {room:"", name:""});
  const r = sanitizeRoom(prompt("輸入房間碼", last.room || "") || "");
  if(!r) return;

  const n = sanitizeName(prompt("輸入暱稱", last.name || "") || "");
  if(!n) return;

  customerRoom = r;
  customerName = n;
  saveJSON("lastCustomerProfile", {room:r, name:n});

  try{
    await ensureRoomDoc(customerRoom);
  }catch(err){
    console.error("ensureRoomDoc failed:", err?.code, err);
    alert("建立/加入房間失敗：\n" + (err?.message || err));
    return;
  }

  showCustomer();
  customerSubscribeRoom();
  setTimeout(()=> customerInput?.focus(), 50);
};

goAdminBtn.onclick = () => {
  adminPassInput.value = "";
  showAdminLogin();
  adminPassInput.focus();
};

backToRoleFromAdmin.onclick = () => showRole();

/* =======================
   Customer
======================= */
function customerRenderChatListItem(lastText, lastTs){
  customerChatList.innerHTML = "";
  const div = document.createElement("div");
  div.className = "chatItem active";

  const seenTs = customerLastSeen[customerRoom] || 0;
  const unread = (lastTs||0) > seenTs ? 1 : 0;

  div.innerHTML = `
    <div class="avatar">${escapeHtml(initials(customerRoom))}</div>
    <div class="chatMain">
      <div class="chatName">${escapeHtml(customerRoom)}</div>
      <div class="chatPreview">${escapeHtml(lastText || "開始對話")}</div>
    </div>
    <div class="chatMeta">
      <div>${lastTs ? fmtTime(lastTs) : ""}</div>
      <div class="badgeUnread ${unread ? "show" : ""}">${unread ? "新" : ""}</div>
    </div>
  `;
  div.onclick = () => {
    if(lastTs){
      customerLastSeen[customerRoom] = lastTs;
      saveJSON("customerLastSeenByRoom", customerLastSeen);
      customerRenderChatListItem(lastText, lastTs);
    }
    customerThread.scrollTop = customerThread.scrollHeight;
  };
  customerChatList.appendChild(div);
}

function customerRenderThread(snap){
  customerThread.innerHTML = "";

  let lastText = "";
  let lastTs = 0;

  snap.forEach(d=>{
    const m = d.data();
    lastText = m.text || lastText;
    lastTs = m.timestamp || lastTs;

    const isMe = (m.role === "user" && m.sender === customerName);

    const row = document.createElement("div");
    row.className = "row " + (isMe ? "me" : "other");

    const bubble = document.createElement("div");
    bubble.className = "bubble " + (isMe ? "me" : "other");
    bubble.innerHTML = `
      <div>${escapeHtml(m.text)}</div>
      <div class="bMeta">
        <span>${escapeHtml(m.role === "admin" ? "👑 管理員" : "🙂 客戶")}</span>
        <span>${escapeHtml(m.sender || "")}</span>
        <span>${fmtTime(m.timestamp)}</span>
      </div>
    `;
    row.appendChild(bubble);
    customerThread.appendChild(row);
  });

  customerRoomTitle.textContent = `房間：${customerRoom}`;
  customerRoomSub.textContent = `暱稱：${customerName}`;

  customerThread.scrollTop = customerThread.scrollHeight;
  customerRenderChatListItem(lastText, lastTs);
}

function customerSubscribeRoom(){
  if(customerUnsubRoom){ customerUnsubRoom(); customerUnsubRoom=null; }

  const msgsRef = collection(db, "rooms", customerRoom, "messages");
  const qy = query(msgsRef, orderBy("timestamp","asc"), limit(500));

  customerUnsubRoom = onSnapshot(qy, (snap)=>{
    customerRenderThread(snap);
  }, (err)=>{
    console.error("customer onSnapshot failed:", err?.code, err);
    alert("客戶端：讀取訊息失敗\n" + (err?.message || err));
  });
}

customerExitBtn.onclick = () => leaveAll();

customerMarkReadBtn.onclick = () => {
  customerLastSeen[customerRoom] = Date.now();
  saveJSON("customerLastSeenByRoom", customerLastSeen);
  customerRenderChatListItem("（已讀）", customerLastSeen[customerRoom]);
};

customerChangeRoomBtn.onclick = async () => {
  const r = sanitizeRoom(prompt("輸入新的房間碼") || "");
  if(!r) return;

  customerRoom = r;
  customerThread.innerHTML = "";
  customerChatList.innerHTML = "";

  try{
    await ensureRoomDoc(customerRoom);
  }catch(err){
    console.error("ensureRoomDoc(new room) failed:", err?.code, err);
    alert("建立/加入新房間失敗：\n" + (err?.message || err));
    return;
  }

  saveJSON("lastCustomerProfile", {room:r, name:customerName});
  customerSubscribeRoom();
};

customerForm.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(mode !== "customer") return;
  const text = customerInput.value.trim();
  if(!text) return;

  try{
    const msgsRef = collection(db, "rooms", customerRoom, "messages");
    await addDoc(msgsRef,{
      room: customerRoom,
      role: "user",
      sender: customerName,
      text,
      timestamp: Date.now()
    });
    customerInput.value = "";
  }catch(err){
    console.error("customer addDoc failed:", err?.code, err);
    alert("客戶端：送出失敗\n" + (err?.message || err));
  }
});

/* =======================
   Admin
======================= */
function adminComputeUnread(room, lastTs){
  const seen = adminLastSeen[room] || 0;
  return (lastTs||0) > seen ? 1 : 0;
}

function adminRenderRoomList(){
  const kw = (adminSearch.value || "").trim().toLowerCase();
  const items = Array.from(adminRoomsMap.values())
    .filter(x => !kw || x.room.toLowerCase().includes(kw))
    .sort((a,b)=> (b.lastTs||0) - (a.lastTs||0));

  adminChatList.innerHTML = "";

  for(const it of items){
    const unread = adminComputeUnread(it.room, it.lastTs);

    const div = document.createElement("div");
    div.className = "chatItem" + (it.room === adminSelectedRoom ? " active" : "");

    div.innerHTML = `
      <div class="avatar">${escapeHtml(initials(it.room))}</div>
      <div class="chatMain">
        <div class="chatName">${escapeHtml(it.room)}</div>
        <div class="chatPreview">${escapeHtml((it.lastRole==="admin"?"👑 ":"🙂 ")+(it.lastSender?it.lastSender+"：":"")+(it.lastText||""))}</div>
      </div>
      <div class="chatMeta">
        <div>${it.lastTs ? fmtTime(it.lastTs) : ""}</div>
        <div class="badgeUnread ${unread ? "show" : ""}">${unread ? "新" : ""}</div>
      </div>
    `;

    div.onclick = () => adminSelectRoom(it.room);
    adminChatList.appendChild(div);
  }
}

function adminSelectRoom(r){
  adminSelectedRoom = r;

  adminRoomTitle.textContent = `房間：${r}`;
  adminRoomSub.textContent = "右側為此房間對話";
  adminInput.disabled = false;
  adminInput.placeholder = "輸入訊息（回覆此房間）";

  const info = adminRoomsMap.get(r);
  if(info?.lastTs){
    adminLastSeen[r] = info.lastTs;
    saveJSON("adminLastSeenByRoom", adminLastSeen);
  }

  adminRenderRoomList();
  adminSubscribeRoom();

  setTimeout(()=> adminInput?.focus(), 50);
}

function adminRenderThread(snap){
  adminThread.innerHTML = "";

  let lastTs = 0;

  snap.forEach(d=>{
    const m = d.data();
    lastTs = m.timestamp || lastTs;

    const isMe = (m.role === "admin");

    const row = document.createElement("div");
    row.className = "row " + (isMe ? "me" : "other");

    const bubble = document.createElement("div");
    bubble.className = "bubble " + (isMe ? "me" : "other");
    bubble.innerHTML = `
      <div>${escapeHtml(m.text)}</div>
      <div class="bMeta">
        <span>${escapeHtml(m.role === "admin" ? "👑 管理員" : "🙂 客戶")}</span>
        <span>${escapeHtml(m.sender || "")}</span>
        <span>${fmtTime(m.timestamp)}</span>
      </div>
    `;
    row.appendChild(bubble);
    adminThread.appendChild(row);
  });

  adminThread.scrollTop = adminThread.scrollHeight;

  if(adminSelectedRoom && lastTs){
    adminLastSeen[adminSelectedRoom] = lastTs;
    saveJSON("adminLastSeenByRoom", adminLastSeen);
    adminRenderRoomList();
  }
}

function adminSubscribeRoom(){
  if(adminUnsubRoom){ adminUnsubRoom(); adminUnsubRoom=null; }
  if(!adminSelectedRoom) return;

  const msgsRef = collection(db, "rooms", adminSelectedRoom, "messages");
  const qy = query(msgsRef, orderBy("timestamp","asc"), limit(500));

  adminUnsubRoom = onSnapshot(qy, (snap)=>{
    adminRenderThread(snap);
  }, (err)=>{
    console.error("admin room onSnapshot failed:", err?.code, err);
    alert("管理員端：讀取房間訊息失敗\n" + (err?.message || err));
  });
}

// ✅ 用 collectionGroup 掃所有 rooms/*/messages，組出「最近房間列表」
function adminSubscribeRecentRooms(){
  if(adminUnsubRecent){ adminUnsubRecent(); adminUnsubRecent=null; }

  const qy = query(
    collectionGroup(db, "messages"),
    orderBy("timestamp", "desc"),
    limit(800)
  );

  adminUnsubRecent = onSnapshot(qy, (snap)=>{
    const next = new Map();

    snap.forEach(d=>{
      const m = d.data();
      const r = m?.room;
      if(!r) return;

      if(!next.has(r)){
        next.set(r, {
          room: r,
          lastText: m.text || "",
          lastTs: m.timestamp || 0,
          lastSender: m.sender || "",
          lastRole: m.role || ""
        });
      }
    });

    adminRoomsMap = next;
    adminRenderRoomList();
  }, (err)=>{
    console.error("admin recent list onSnapshot failed:", err?.code, err);
    alert("管理員端：讀取聊天列表失敗\n" + (err?.message || err));
  });
}

async function enterAdmin(){
  const pass = (adminPassInput.value || "").trim();
  if(!pass) return alert("Admin password is required");

  adminEnterBtn.disabled = true;
  adminEnterBtn.textContent = "Checking...";

  try{
    await verifyAdminPassword(pass);
    await ensureAdminSignedIn();
    adminPassInput.value = "";
  }catch(err){
    console.error("admin ensureAdminSignedIn failed:", err?.message || err);
    const msg = String(err?.message || err);
    if (msg.includes("ADMIN_API_NOT_CONFIGURED")) {
      alert("Admin API is not configured. Open with ?api=https://your-backend or set VITE_API_BASE_URL.");
    } else if (msg.includes("NOT_WHITELISTED_ADMIN")) {
      alert("This account is not in the admin whitelist.");
    } else if (msg.includes("ADMIN_CREDENTIALS_MISSING")) {
      // user closed the prompt
    } else {
      alert("Admin sign-in failed.\n" + msg);
    }
    adminEnterBtn.disabled = false;
    adminEnterBtn.textContent = "Login";
    return;
  }

  adminEnterBtn.disabled = false;
  adminEnterBtn.textContent = "Login";

  adminSelectedRoom = "";
  adminThread.innerHTML = "";
  adminRoomTitle.textContent = "Select a room";
  adminRoomSub.textContent = "Choose a customer room from the list";
  adminInput.disabled = true;
  adminInput.value = "";
  adminInput.placeholder = "Select a room first";

  showAdmin();
  adminSubscribeRecentRooms();
}

adminEnterBtn.onclick = () => enterAdmin();
adminPassInput.addEventListener("keydown", (e)=>{ if(e.key==="Enter") enterAdmin(); });

adminExitBtn.onclick = () => leaveAll();
adminSearch.addEventListener("input", () => adminRenderRoomList());

adminNewRoomBtn.onclick = async () => {
  const r = sanitizeRoom(prompt("輸入房間碼（你要打開的客戶房間）") || "");
  if(!r) return;

  try{
    await ensureRoomDoc(r);
  }catch(err){
    console.error("ensureRoomDoc(admin new room) failed:", err?.code, err);
    alert("建立/加入房間失敗：\n" + (err?.message || err));
    return;
  }

  if(!adminRoomsMap.has(r)){
    adminRoomsMap.set(r, { room:r, lastText:"（手動開啟）", lastTs:0, lastSender:"", lastRole:"" });
    adminRenderRoomList();
  }
  adminSelectRoom(r);
};

adminMarkReadBtn.onclick = () => {
  if(!adminSelectedRoom) return;
  const info = adminRoomsMap.get(adminSelectedRoom);
  const ts = info?.lastTs || Date.now();
  adminLastSeen[adminSelectedRoom] = ts;
  saveJSON("adminLastSeenByRoom", adminLastSeen);
  adminRenderRoomList();
};

adminCopyRoomBtn.onclick = async () => {
  if(!adminSelectedRoom) return alert("請先選擇房間");
  try{
    await navigator.clipboard.writeText(adminSelectedRoom);
    alert("已複製房間碼：" + adminSelectedRoom);
  }catch(e){
    alert("複製失敗（瀏覽器限制），房間碼：" + adminSelectedRoom);
  }
};

async function deleteRoomAllMessages(room){
  const BATCH_SIZE = 450;
  let total = 0;
  let lastDocSnap = null;

  while(true){
    const msgsRef = collection(db, "rooms", room, "messages");
    const baseQ = query(msgsRef, orderBy("timestamp", "asc"), limit(BATCH_SIZE));
    const pageQ = lastDocSnap ? query(baseQ, startAfter(lastDocSnap)) : baseQ;

    const snap = await getDocs(pageQ);
    if(snap.empty) break;

    const batch = writeBatch(db);
    snap.docs.forEach(ds => batch.delete(ds.ref));
    await batch.commit();

    total += snap.size;
    lastDocSnap = snap.docs[snap.docs.length - 1];
    if(snap.size < BATCH_SIZE) break;
  }

  return total;
}

adminDeleteRoomBtn.onclick = async () => {
  if(mode !== "admin") return;
  if(!adminSelectedRoom) return alert("請先選擇左側房間");

  // ✅ 再保險一次：刪除前確認仍是白名單管理員
  const cur = auth.currentUser;
  if(!cur || !ADMIN_UIDS.has(cur.uid)){
    alert("刪除需要白名單管理員登入");
    try{ await signOut(auth); }catch{}
    showRole();
    return;
  }

  const room = adminSelectedRoom;
  const ok = confirm(`確定要刪除房間「${room}」的所有訊息？\n此動作不可復原。`);
  if(!ok) return;

  try{
    if(adminUnsubRoom){ adminUnsubRoom(); adminUnsubRoom=null; }

    const count = await deleteRoomAllMessages(room);

    adminSelectedRoom = "";
    adminThread.innerHTML = "";
    adminRoomTitle.textContent = "尚未選擇房間";
    adminRoomSub.textContent = "點左側聊天室開始回覆";
    adminInput.disabled = true;
    adminInput.value = "";
    adminInput.placeholder = "請先選擇房間…";

    adminRoomsMap.delete(room);
    adminRenderRoomList();

    alert(`已刪除 ${count} 則訊息（房間：${room}）`);
  }catch(err){
    console.error("admin delete failed:", err?.code, err);
    alert("刪除失敗：\n" + (err?.message || err));
    adminSubscribeRoom();
  }
};

adminForm.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(mode !== "admin") return;
  if(!adminSelectedRoom) return alert("請先選擇左側房間");

  const text = adminInput.value.trim();
  if(!text) return;

  // ✅ 送訊息前也確保是白名單管理員（避免匿名偽裝）
  const cur = auth.currentUser;
  if(!cur || !ADMIN_UIDS.has(cur.uid)){
    alert("發送管理員訊息需要白名單管理員登入");
    try{ await signOut(auth); }catch{}
    showRole();
    return;
  }

  try{
    const msgsRef = collection(db, "rooms", adminSelectedRoom, "messages");
    await addDoc(msgsRef,{
      room: adminSelectedRoom,
      role: "admin",
      sender: "管理員",
      text,
      timestamp: Date.now()
    });
    adminInput.value = "";
  }catch(err){
    console.error("admin addDoc failed:", err?.code, err);
    alert("管理員端：送出失敗\n" + (err?.message || err));
  }
});

/* =======================
   Start
======================= */
showRole();
