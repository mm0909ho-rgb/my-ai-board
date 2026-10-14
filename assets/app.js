(function(){
"use strict";
const {
  useState,
  useEffect,
  useMemo,
  useRef
} = React;

// ⚠️ 請填入你的 Supabase 連線資訊 ⚠️
const SUPABASE_URL = "https://pbdgrwokkulcjsyoknhu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBiZGdyd29ra3VsY2pzeW9rbmh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MzA2NDIsImV4cCI6MjEwMjMwNjY0Mn0.uDEfM8o5B81IjjG9dw1bUqNA7BRdlriPXhJe7EZYZOQ";
const isConfigured = SUPABASE_URL && !SUPABASE_URL.includes("your-project-id");
const supabase = isConfigured && window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: async (input, init = {}) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (init.signal?.aborted) cancel();
    else init.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 12000);
    try { return await window.fetch(input, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); init.signal?.removeEventListener('abort', cancel); }
  } }
}) : null;

// 帳號格式：需同時包含英文字母與數字
const ACCOUNT_REGEX = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]+$/;
// 密碼格式：固定 6 碼數字
const PASSWORD_REGEX = /^\d{6}$/;

// ===== 密碼雜湊（SHA-256 + 固定 salt；瀏覽器內建，不需額外套件）=====
// 註：這比明文安全很多，但因是純前端固定 salt，並非最高等級。
// 若日後要最嚴謹，應改用 Supabase Auth（伺服器端 bcrypt）。
const PWD_SALT = "jj_ai_board::";
const hashPassword = async plain => {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PWD_SALT + plain));
    return 'sha256$' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return plain; // 極少數不支援的環境，退回明文（不致命）
  }
};
const isHashed = v => typeof v === 'string' && v.startsWith('sha256$');
// 比對密碼：支援明文（舊資料）與雜湊（新資料）
const verifyPassword = async (input, stored) => {
  if (stored == null) return false;
  if (isHashed(stored)) return (await hashPassword(input)) === stored;
  return input === stored; // 舊的明文密碼
};

// ===== 角色（三層）=====
// BOSS 主管（最高）、ADMIN 管理員、MEMBER 一般成員
const ROLE_LABEL = {
  BOSS: "BOSS",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER"
};
const roleLabel = r => ROLE_LABEL[r] || "一般成員";
const isBoss = u => u && u.role === "BOSS";
const canAccessAccounts = u => u && (u.role === "BOSS" || u.role === "ADMIN"); // 能進帳號管理
// 目前登入者(me)能否管理某個目標帳號(target)
// 規則：主管(BOSS)可管理所有人；管理員(ADMIN)可管理 ADMIN 與 MEMBER，但不能動 BOSS
const canManageAccount = (me, target) => {
  if (!me || !target) return false;
  if (me.role === "BOSS") return true;
  if (me.role === "ADMIN") return target.role !== "BOSS";
  return false;
};

// 登入狀態儲存 Key（localStorage 依「網域」各自獨立保存）
const SESSION_KEY = "ai_dashboard_session";
const THEME_KEY = "ai_dashboard_theme";
// 閒置多久自動登出：4 小時
const INACTIVITY_LIMIT_MS = 4 * 60 * 60 * 1000;
const STATUS_LIST = ["規劃", "開發測試中", "上線", "下線"];
// 舊版若曾儲存獨立的「開發」或「測試」，統一顯示為「開發測試中」。
const normalizeStatus = s => ["開發", "測試"].includes(s) ? "開發測試中" : STATUS_LIST.includes(s) ? s : "開發測試中";
const CATEGORY_LIST = ["工作", "生活"];
const EXTRA_DEFAULTS = {
  category: ""
};
// Compatibility extension: versioned metadata in the existing text progress column.
// No schema change. Free-text history is preserved. Use this editor for future edits;
// older clients cannot preserve the extension when replacing progress themselves.
const META_MARKER = "\n<!-- AI_BOARD_META_V1:";
const readProgress = value => {
  const raw = typeof value === 'string' ? value : '';
  const at = raw.lastIndexOf(META_MARKER);
  if (at < 0 || !raw.endsWith('-->')) return {
    text: raw,
    meta: {}
  };
  try {
    const meta = JSON.parse(decodeURIComponent(raw.slice(at + META_MARKER.length, -3)));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {
      text: raw,
      meta: {}
    };
    return {
      text: raw.slice(0, at),
      meta
    };
  } catch (e) {
    return {
      text: raw,
      meta: {}
    };
  }
};
const cleanProgress = value => readProgress(value).text;
const normalizeCategory = category => {
  const value = String(category || "").trim();
  if (!value || value === "尚未分類") return "";
  if (value === "生活" || value.startsWith("生活・")) return "生活";
  // 舊版的排班、交接、客服、對帳等細分類統一歸入工作。
  return "工作";
};
const projectMeta = p => ({
  category: normalizeCategory(readProgress(p.progress).meta.category)
});
const projectStage = p => normalizeStatus(projectMeta(p).stage || p.status);
const packProgress = (text, meta) => cleanProgress(text) + META_MARKER + encodeURIComponent(JSON.stringify(meta)) + '-->';
const storageStatus = s => ["開發", "測試"].includes(s) ? "開發測試中" : s;
const usefulText = t => !!(t && !['無', '未填寫', '-'].includes(String(t).trim()));
const summaryOf = p => [p.target, p.pain_point].find(usefulText) || '尚未補充用途說明';
const catalogCopyOf = (p, mode) => {
  if (mode === '學做法') return usefulText(p.solution) ? p.solution : '尚未補充做法，可從完整詳情留言請教負責人。';
  return [p.pain_point, p.target].find(usefulText) || '尚未補充適用情境。';
};
// 由名稱與既有欄位自動整理「有明確依據」的亮點；沒有依據就不顯示，避免每張卡片都一樣。
const methodHighlightsOf = p => {
  const title = String(p.title || '');
  const source = [title, p.solution, p.target, p.pain_point, cleanProgress(p.progress), p.ai_tools].filter(Boolean).join(' ');
  const methodSource = [p.solution, cleanProgress(p.progress)].filter(Boolean).join(' ');
  const specificRules = [
    [/錄音|語音|音訊|逐字稿|Whisper/i, ['語音轉寫', '重點摘要', '內容可回查']],
    [/訂單|款項|對帳|核對|金額|帳務|財務/i, ['自動核對', '標出差異', '保留複核依據']],
    [/排班|班表|出勤|輪班|調班/i, ['班表自動化', '降低排班衝突', '出勤快速彙整']],
    [/客服|話術|回覆|客訴|訊息/i, ['回覆建議', '統一服務口徑', '縮短處理時間']],
    [/交接|待辦|派工|任務/i, ['交接留痕', '事項追蹤', '責任更清楚']],
    [/提醒|通知|推播|警示/i, ['主動提醒', '到期追蹤', '降低遺漏']],
    [/監控|監看|情報|追蹤|狀態監控/i, ['持續監測', '異常提示', '快速掌握狀態']],
    [/文件|檔案|資料夾|查找|搜尋|檢索/i, ['集中查找', '分類歸檔', '減少翻找時間']],
    [/截圖|照片|相簿|圖片/i, ['圖片自動整理', '內容分類', '兼顧隱私']],
    [/抽獎|抽籤|中獎|獎品/i, ['獎項分開抽選', '結果自動留存', '流程更透明']],
    [/報表|統計|儀表板|Dashboard|數據/i, ['資料自動彙整', '重點視覺化', '快速掌握趨勢']],
    [/翻譯|多語|語言/i, ['快速翻譯', '保留原始格式', '降低人工校對']],
    [/發票|報銷|收據|憑證/i, ['資料辨識', '自動歸檔', '方便後續查核']],
    [/登入|帳號|權限|後台/i, ['集中管理', '權限控管', '操作留痕']],
    [/行程|旅遊|景點|路線/i, ['行程快速規劃', '路線集中整理', '方便調整安排']],
    [/健康|飲食|減脂|運動|健身/i, ['個人化建議', '進度追蹤', '日常容易執行']],
    [/活動|企劃|節慶|文案/i, ['快速產生提案', '多版本比較', '文案同步整理']]
  ];
  const methodRules = [
    [/自動|排程|定時|機器人/i, '自動執行'],
    [/差異|異常|不一致|錯誤/i, '聚焦例外'],
    [/紀錄|記錄|日誌|歷程|留存|回查/i, '保留處理紀錄'],
    [/摘要|重點|歸納/i, '擷取重點'],
    [/分類|分段|分組|標籤/i, '結構化整理'],
    [/格式|標準化|正規化|欄位/i, '格式標準化'],
    [/本機|離線|隱私|不離開裝置/i, '資料留在本機']
  ];
  const found = [];
  specificRules.forEach(([pattern, labels]) => {
    if (pattern.test(source)) found.push(...labels);
  });
  methodRules.forEach(([pattern, label]) => {
    if (pattern.test(methodSource)) found.push(label);
  });
  return [...new Set(found)].slice(0, 3);
};
const catalogCompletenessOf = p => {
  const filled = [p.pain_point, p.target, p.solution].filter(usefulText).length;
  return filled >= 3 ? '資料完整 · 可直接參考' : filled >= 1 ? '已有重點 · 可繼續補充' : '資料較少 · 建議先看詳情';
};
const toolName = t => ({
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  'google sheet': 'Google Sheets',
  'google sheets': 'Google Sheets',
  github: 'GitHub',
  'google apps script': 'Google Apps Script'
})[t.trim().toLowerCase()] || t.trim();
const safeLink = value => {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) ? u.href : '';
  } catch (e) {
    return '';
  }
};
const projectTime = p => {
  const t = Date.parse(p.start_date || p.created_at || '');
  return Number.isFinite(t) ? t : 0;
};
const inPeriod = (p, days) => days === 'all' || projectTime(p) > 0 && projectTime(p) <= Date.now() && projectTime(p) >= Date.now() - Number(days) * 86400000;
// 解析協作者欄位（JSON 陣列字串 → 名稱陣列）
const parseCollab = val => {
  if (!val) return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch (e) {
    return [];
  }
};

// 把「目前進展」拆成分列：優先用換行，若整段沒換行則用日期(如 8/16、2026/8/16)當分隔
const splitProgress = text => {
  if (!text) return [];
  let raw = String(text).trim();
  if (/[\r\n]/.test(raw)) {
    return raw.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  }
  const parts = raw.split(/(?=(?:\d{4}\/)?\d{1,2}\/\d{1,2}[\s　])/).map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [raw];
};
const MAX_IMAGES = 3;
const MAX_FILES = 3; // 相關文件最多 3 個
const MAX_FILE_MB = 20; // 單一文件上限
const MAX_VIDEO_MB = 50; // 教學影片上限
const STORAGE_BUCKET = "project-files";

// 單位選項（含三班）
const UNIT_OPTIONS = ["JJ-早", "JJ-中", "JJ-晚"];
const getShift = u => {
  if (u.unit && u.unit.includes('-')) return u.unit.split('-')[1];
  return u.shift || '';
};
const getBaseUnit = u => {
  if (!u.unit) return 'JJ';
  return u.unit.split('-')[0];
};
const unitOfUser = u => {
  if (!u) return '';
  if (UNIT_OPTIONS.includes(u.unit)) return u.unit;
  return `${getBaseUnit(u)}-${getShift(u) || '早'}`;
};

// 解析 image_url：支援舊格式（單一字串）與新格式（JSON 陣列字串）
const parseImages = val => {
  if (!val) return [];
  if (typeof val === 'string' && val.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(val);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch (e) {
      return [val];
    }
  }
  return [val];
};

// 解析 files 欄位：JSON 陣列 [{name, url}]
const parseFiles = val => {
  if (!val) return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr.filter(x => x && x.url) : [];
  } catch (e) {
    return [];
  }
};

// 產生「強制下載」網址（Supabase Storage 支援 ?download=檔名，會以附件方式下載並保留原檔名）
const downloadUrl = (url, name) => {
  if (!url) return url;
  return url + (url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(name || '');
};

// ===== Session 讀寫（含最後活動時間，供閒置登出判斷）=====
const readSession = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!raw) return null;
    // 相容舊格式（直接存 user 物件）
    if (raw.account && !raw.user) return {
      user: raw,
      lastActive: Date.now()
    };
    if (raw.user && raw.user.account) return raw;
    return null;
  } catch (e) {
    return null;
  }
};
const writeSession = user => {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      user,
      lastActive: Date.now()
    }));
  } catch (e) {}
};
const clearSession = () => {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
};
function App() {
  const [currentTab, setCurrentTab] = useState("總覽");
  const [projects, setProjects] = useState([]);

  // Theme selection persists independently from resolved system appearance.
  const [theme, setTheme] = useState(() => {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (['dark', 'light'].includes(v)) return v;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
    const sync = e => {
      if (e.key === THEME_KEY && ['dark', 'light'].includes(e.newValue)) setTheme(e.newValue);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [theme]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('全部');
  const [catalogMode, setCatalogMode] = useState('找工具');
  const [catalogAvailable, setCatalogAvailable] = useState(false);
  const [memberPeriod, setMemberPeriod] = useState('all');
  const [expandedMembers, setExpandedMembers] = useState([]);
  // 本地模擬模式下的預設帳號
  const [users, setUsers] = useState([{
    id: "1",
    name: "Admin",
    account: "admin01",
    password: "123456",
    role: "BOSS",
    unit: "JJ-早",
    shift: "早",
    status: "active"
  }, {
    id: "2",
    name: "成員 A",
    account: "usera01",
    password: "111111",
    role: "MEMBER",
    unit: "JJ-中",
    shift: "中",
    status: "active"
  }]);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterRole, setFilterRole] = useState("all");
  const [groupBy, setGroupBy] = useState("role");
  const groupedUsers = useMemo(() => {
    const filtered = users.filter(u => filterRole === "all" || u.role === filterRole).filter(u => !searchTerm || u.name.toLowerCase().includes(searchTerm.toLowerCase()) || u.account.toLowerCase().includes(searchTerm.toLowerCase()));
    const roleOrder = {
      BOSS: 0,
      ADMIN: 1,
      MEMBER: 2
    };
    const shiftOrder = {
      "早": 0,
      "中": 1,
      "晚": 2
    };
    const roleLabel = {
      BOSS: "管理層 - BOSS",
      ADMIN: "管理層 - ADMIN",
      MEMBER: "一般成員"
    };
    const shiftLabel = {
      "早": "早班",
      "中": "中班",
      "晚": "晚班"
    };
    const groupKeyOf = groupBy === "role" ? u => u.role : u => u.shift;
    const groupOrder = groupBy === "role" ? ["BOSS", "ADMIN", "MEMBER"] : ["早", "中", "晚"];
    const labelOf = groupBy === "role" ? roleLabel : shiftLabel;
    const groups = {};
    filtered.forEach(u => {
      const key = groupKeyOf(u);
      if (!groups[key]) groups[key] = [];
      groups[key].push(u);
    });
    Object.values(groups).forEach(list => {
      list.sort((a, b) => {
        const diff = groupBy === "role" ? (shiftOrder[a.shift] ?? 3) - (shiftOrder[b.shift] ?? 3) : (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name, 'zh-Hant');
      });
    });
    return groupOrder.filter(key => groups[key] && groups[key].length > 0).map(key => ({
      key,
      label: labelOf[key],
      members: groups[key]
    }));
  }, [users, filterRole, searchTerm, groupBy]);

  // ===== 登入狀態 =====
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [loginForm, setLoginForm] = useState({
    account: "",
    password: ""
  });
  const [loginError, setLoginError] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [restoring, setRestoring] = useState(true);

  // Modal 控制
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState(null);
  const [viewingProjectId, setViewingProjectId] = useState(null);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxSize, setLightboxSize] = useState(null);
  const detailOrigin = useRef({ tab: "專案列表", scrollY: 0 });
  const lightboxCloseRef = useRef(null);
  useEffect(() => {
    if (!lightboxUrl) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    lightboxCloseRef.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [lightboxUrl]);

  // 上傳中狀態
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);

  // ===== 編輯成員帳號 Modal =====
  const [editUserTarget, setEditUserTarget] = useState(null);
  const [editUserForm, setEditUserForm] = useState({
    name: "",
    role: "MEMBER",
    unit: "JJ-早",
    password: ""
  });
  const [editUserSaving, setEditUserSaving] = useState(false);

  // ===== 留言與更新紀錄 =====
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  // ===== 搜尋 / 篩選 =====
  const [searchText, setSearchText] = useState("");
  const [filterStatus, setFilterStatus] = useState("全部");
  const [filterAuthor, setFilterAuthor] = useState("全部");
  const [filterType, setFilterType] = useState("全部");
  const [filterShift, setFilterShift] = useState("全部");

  // 單位成員頁：班別分頁（全部 / JJ-早 / JJ-中 / JJ-晚）
  const [memberShift, setMemberShift] = useState("全部");

  // 專案列表：排序方式 + 只看我的
  const [sortBy, setSortBy] = useState("最新");
  const [onlyMine, setOnlyMine] = useState(false);

  // 專案查看密碼：已解鎖的專案 id 清單、密碼輸入視窗
  const [unlockedIds, setUnlockedIds] = useState([]);
  const [pwPrompt, setPwPrompt] = useState(null); // { project }
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");

  // 自助修改自己的密碼
  const [showMyPwModal, setShowMyPwModal] = useState(false);
  const [myPwForm, setMyPwForm] = useState({
    oldPw: "",
    newPw: "",
    confirmPw: ""
  });
  const [myPwSaving, setMyPwSaving] = useState(false);
  const [myPwError, setMyPwError] = useState("");

  // 發布 / 編輯專案 Form
  const [newProject, setNewProject] = useState({
    title: "",
    type: "小工具",
    dept: "JJ",
    author: "",
    status: "開發測試中",
    link: "",
    images: [],
    files: [],
    video: "",
    collaborators: [],
    ai_tools: "",
    pain_point: "",
    target: "",
    solution: "",
    progress: "",
    view_password: "",
    ...EXTRA_DEFAULTS
  });

  // 新增成員 Form
  const [newUser, setNewUser] = useState({
    name: "",
    account: "",
    password: "",
    email: "",
    role: "MEMBER",
    unit: "JJ-早",
    shift: "早"
  });

  // ===== 閒置自動登出 =====
  const lastTouchRef = useRef(Date.now());
  const lastWriteRef = useRef(0);
  const forceLogout = notice => {
    setIsLoggedIn(false);
    setUnlockedIds([]);
    setPwPrompt(null);
    setShowProjectModal(false);
    setShowUserModal(false);
    setEditUserTarget(null);
    setShowMyPwModal(false);
    setCurrentUser(null);
    setLoginForm({
      account: "",
      password: ""
    });
    setLoginError("");
    setCurrentTab("專案列表");
    setViewingProjectId(null);
    clearSession();
    if (notice) setSessionNotice(notice);
  };
  useEffect(() => {
    if (!isLoggedIn) return;
    lastTouchRef.current = Date.now();
    const touch = () => {
      const now = Date.now();
      lastTouchRef.current = now;
      // 節流：最多每 60 秒寫入一次 localStorage
      if (now - lastWriteRef.current > 60 * 1000) {
        lastWriteRef.current = now;
        try {
          const s = readSession();
          if (s) {
            s.lastActive = now;
            localStorage.setItem(SESSION_KEY, JSON.stringify(s));
          }
        } catch (e) {}
      }
    };
    const check = () => {
      let last = lastTouchRef.current;
      const s = readSession();
      if (s && s.lastActive) last = Math.max(last, s.lastActive);
      if (Date.now() - last > INACTIVITY_LIMIT_MS) {
        forceLogout("閒置超過 4 小時，為了安全已自動登出，請重新登入");
      }
    };
    const events = ['click', 'keydown', 'scroll', 'touchstart'];
    events.forEach(ev => window.addEventListener(ev, touch, {
      passive: true
    }));
    const timer = setInterval(check, 60 * 1000);
    return () => {
      events.forEach(ev => window.removeEventListener(ev, touch));
      clearInterval(timer);
    };
  }, [isLoggedIn]);

  // ===== 初始化：還原登入狀態 + 讀取資料 =====
  useEffect(() => {
    const init = async () => {
      try {
        const saved = readSession();
        if (saved && saved.user && saved.user.account) {
          // 閒置超過 4 小時 → 不還原，要求重新登入
          if (saved.lastActive && Date.now() - saved.lastActive > INACTIVITY_LIMIT_MS) {
            clearSession();
            setSessionNotice("閒置超過 4 小時，為了安全已自動登出，請重新登入");
          } else if (supabase) {
            const {
              data
            } = await supabase.from('profiles').select('*').eq('account', saved.user.account).maybeSingle();
            if (data && data.status !== 'disabled') {
              const userObj = {
                id: data.id,
                name: data.name,
                role: data.role,
                account: data.account
              };
              setCurrentUser(userObj);
              setIsLoggedIn(true);
              writeSession(userObj);
            } else {
              clearSession();
            }
          } else {
            setCurrentUser(saved.user);
            setIsLoggedIn(true);
            writeSession(saved.user);
          }
        }
      } catch (e) {
        console.error("還原登入狀態失敗：", e);
      } finally {
        setRestoring(false);
      }
      fetchData();
    };
    init();
  }, []);

  // ESC 關閉燈箱
  useEffect(() => {
    const onKey = e => {
      if (e.key === "Escape") setLightboxUrl(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const fetchData = async () => {
    if (supabase) {
      try {
        const {
          data: projData
        } = await supabase.from('projects').select('*').order('id', {
          ascending: false
        });
        const {
          data: userData
        } = await supabase.from('profiles').select('*').order('role_priority', {
          ascending: true
        }).order('shift_priority', {
          ascending: true
        }).order('name', {
          ascending: true
        });
        if (projData) setProjects(projData);
        if (userData && userData.length > 0) setUsers(userData);
        const {
          data: commentData
        } = await supabase.from('comments').select('*').order('id', {
          ascending: true
        });
        if (commentData) setComments(commentData);
      } catch (err) {
        console.error("讀取失敗：", err);
      }
    }
  };

  // ===== 登入 =====
  const handleLogin = async e => {
    e.preventDefault();
    setLoginError("");
    setSessionNotice("");
    const account = loginForm.account.trim();
    const password = loginForm.password.trim();
    if (!account || !password) {
      setLoginError("請輸入帳號與密碼");
      return;
    }
    setLoggingIn(true);
    try {
      let userObj = null;
      if (supabase) {
        const {
          data,
          error
        } = await supabase.from('profiles').select('*').eq('account', account).maybeSingle();
        if (error || !data || !(await verifyPassword(password, data.password))) {
          setLoginError("帳號或密碼錯誤");
        } else if (data.status === 'disabled') {
          setLoginError("此帳號已被停用，請聯絡管理員");
        } else {
          userObj = {
            id: data.id,
            name: data.name,
            role: data.role,
            account: data.account
          };
          // 自動升級：若資料庫仍是明文密碼，登入成功後轉存為雜湊
          if (!isHashed(data.password)) {
            try {
              const hashed = await hashPassword(password);
              await supabase.from('profiles').update({
                password: hashed
              }).eq('id', data.id);
            } catch (e) {/* 升級失敗不影響登入 */}
          }
        }
      } else {
        const matched = users.find(u => u.account === account);
        if (!matched || !(await verifyPassword(password, matched.password))) {
          setLoginError("帳號或密碼錯誤（本地模擬模式）");
        } else if (matched.status === 'disabled') {
          setLoginError("此帳號已被停用，請聯絡管理員");
        } else {
          userObj = {
            id: matched.id,
            name: matched.name,
            role: matched.role,
            account: matched.account
          };
        }
      }
      if (userObj) {
        setCurrentUser(userObj);
        setIsLoggedIn(true);
        setCurrentTab("總覽");
        writeSession(userObj);
      }
    } catch (err) {
      setLoginError("登入時發生錯誤，請稍後再試");
    } finally {
      setLoggingIn(false);
    }
  };
  const handleLogout = () => {
    if (confirm("確定要登出系統嗎？")) forceLogout("");
  };

  // 自助修改自己的密碼
  const handleChangeMyPassword = async e => {
    e.preventDefault();
    setMyPwError("");
    const {
      oldPw,
      newPw,
      confirmPw
    } = myPwForm;
    if (!oldPw || !newPw || !confirmPw) {
      setMyPwError("請完整填寫三個欄位");
      return;
    }
    if (!PASSWORD_REGEX.test(newPw)) {
      setMyPwError("新密碼需為 6 位數字");
      return;
    }
    if (newPw !== confirmPw) {
      setMyPwError("兩次輸入的新密碼不一致");
      return;
    }
    setMyPwSaving(true);
    try {
      if (supabase) {
        // 先向資料庫確認舊密碼正確
        const {
          data,
          error
        } = await supabase.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
        if (error || !data) {
          setMyPwError("讀取帳號失敗，請稍後再試");
          setMyPwSaving(false);
          return;
        }
        if (!(await verifyPassword(oldPw, data.password))) {
          setMyPwError("目前密碼不正確");
          setMyPwSaving(false);
          return;
        }
        const {
          error: upErr
        } = await supabase.from('profiles').update({
          password: newPw
        }).eq('id', currentUser.id);
        if (upErr) {
          setMyPwError("更新失敗：" + upErr.message);
          setMyPwSaving(false);
          return;
        }
        setUsers(users.map(u => u.id === currentUser.id ? {
          ...u,
          password: newPw
        } : u));
      } else {
        const me = users.find(u => u.id === currentUser.id);
        if (!me || !(await verifyPassword(oldPw, me.password))) {
          setMyPwError("目前密碼不正確");
          setMyPwSaving(false);
          return;
        }
        setUsers(users.map(u => u.id === currentUser.id ? {
          ...u,
          password: newPw
        } : u));
      }
      setShowMyPwModal(false);
      setMyPwForm({
        oldPw: "",
        newPw: "",
        confirmPw: ""
      });
      alert("✅ 密碼已更新，下次登入請用新密碼");
    } catch (err) {
      setMyPwError("發生錯誤，請稍後再試");
    } finally {
      setMyPwSaving(false);
    }
  };

  // 專案編輯／刪除權限：發布者本人，或列名的共同研究成員（管理員也不能改別人的專案）
  const canManageProject = item => {
    if (!currentUser) return false;
    if (item.author === currentUser.name) return true;
    return parseCollab(item.collaborators).includes(currentUser.name);
  };

  // ⚡ 圖片自動等比例壓縮 (最高 800px，品質 70%)
  const compressImage = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("讀取圖片失敗"));
    reader.onload = event => {
      const img = new Image();
      img.onerror = () => reject(new Error("圖片格式不支援"));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxDim = 800;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round(height * maxDim / width);
            width = maxDim;
          } else {
            width = Math.round(width * maxDim / height);
            height = maxDim;
          }
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });

  // 上傳 1~3 張圖片
  const handleImageUpload = async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const remaining = MAX_IMAGES - newProject.images.length;
    if (remaining <= 0) {
      alert(`最多只能上傳 ${MAX_IMAGES} 張圖片，請先刪除不要的圖片`);
      return;
    }
    if (files.length > remaining) alert(`最多 ${MAX_IMAGES} 張，將只加入前 ${remaining} 張`);
    try {
      const toProcess = files.slice(0, remaining);
      const results = [];
      for (const f of toProcess) results.push(await compressImage(f));
      setNewProject(prev => ({
        ...prev,
        images: [...prev.images, ...results].slice(0, MAX_IMAGES)
      }));
    } catch (err) {
      alert("圖片處理失敗：" + err.message);
    }
  };
  const handleRemoveImage = idx => {
    setNewProject(prev => ({
      ...prev,
      images: prev.images.filter((_, i) => i !== idx)
    }));
  };

  // 上傳檔案到 Supabase Storage，回傳公開網址
  const uploadToStorage = async (file, folder) => {
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const path = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const {
      error
    } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file);
    if (error) throw error;
    const {
      data
    } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  };

  // 📎 上傳相關文件（txt/pdf/office 等，最多 3 個）
  const handleDocUpload = async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const remaining = MAX_FILES - newProject.files.length;
    if (remaining <= 0) {
      alert(`最多只能上傳 ${MAX_FILES} 個文件，請先刪除不要的`);
      return;
    }
    const toProcess = files.slice(0, remaining);
    if (files.length > remaining) alert(`最多 ${MAX_FILES} 個文件，將只加入前 ${remaining} 個`);
    setUploadingFiles(true);
    try {
      const added = [];
      for (const f of toProcess) {
        if (f.size > MAX_FILE_MB * 1024 * 1024) {
          alert(`「${f.name}」超過 ${MAX_FILE_MB}MB，已略過`);
          continue;
        }
        const url = supabase ? await uploadToStorage(f, 'docs') : URL.createObjectURL(f);
        added.push({
          name: f.name,
          url
        });
      }
      if (added.length) {
        setNewProject(prev => ({
          ...prev,
          files: [...prev.files, ...added].slice(0, MAX_FILES)
        }));
      }
    } catch (err) {
      alert("文件上傳失敗：" + err.message + "\n\n（若錯誤與 bucket 或權限有關，請先到 Supabase 建立 " + STORAGE_BUCKET + " 儲存空間並設定政策）");
    } finally {
      setUploadingFiles(false);
    }
  };
  const handleRemoveFile = idx => {
    setNewProject(prev => ({
      ...prev,
      files: prev.files.filter((_, i) => i !== idx)
    }));
  };

  // 🎬 上傳操作教學影片（1 部）
  const handleVideoUpload = async e => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      alert("請上傳影片檔（mp4 / webm 等格式）");
      return;
    }
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      alert(`影片超過 ${MAX_VIDEO_MB}MB 上限，請先壓縮或剪輯後再上傳`);
      return;
    }
    setUploadingVideo(true);
    try {
      const url = supabase ? await uploadToStorage(file, 'videos') : URL.createObjectURL(file);
      setNewProject(prev => ({
        ...prev,
        video: url
      }));
    } catch (err) {
      alert("影片上傳失敗：" + err.message + "\n\n（若錯誤與 bucket 或權限有關，請先到 Supabase 建立 " + STORAGE_BUCKET + " 儲存空間並設定政策）");
    } finally {
      setUploadingVideo(false);
    }
  };
  const handleRemoveVideo = () => {
    setNewProject(prev => ({
      ...prev,
      video: ""
    }));
  };

  // 開啟「編輯專案」彈窗
  const handleOpenEditProject = item => {
    if (!canManageProject(item)) {
      alert("僅發布者本人可編輯此專案");
      return;
    }
    setNewProject({
      title: item.title || "",
      type: item.type || "小工具",
      dept: item.dept || "JJ",
      author: item.author || "",
      status: projectStage(item),
      link: item.link || "",
      images: parseImages(item.image_url),
      files: parseFiles(item.files),
      video: item.video_url || "",
      collaborators: parseCollab(item.collaborators),
      ai_tools: item.ai_tools || "",
      pain_point: item.pain_point || "",
      target: item.target || "",
      solution: item.solution || "",
      progress: cleanProgress(item.progress),
      ...projectMeta(item),
      view_password: item.view_password || ""
    });
    setEditingProjectId(item.id);
    setShowProjectModal(true);
  };
  const handleCloseProjectModal = () => {
    setShowProjectModal(false);
    setEditingProjectId(null);
    resetProjectForm();
  };

  // 表單 → 資料庫欄位
  const buildProjectPayload = form => {
    const {
      images,
      files,
      video,
      collaborators,
      category,
      summary,
      usage,
      outcome,
      evidence,
      next_step,
      due,
      stage,
      ...rest
    } = form;
    const finalAuthor = rest.author || (currentUser ? currentUser.name : "");
    const collab = (collaborators || []).filter(n => n && n !== finalAuthor);
    return {
      ...rest,
      status: storageStatus(rest.status),
      progress: packProgress(rest.progress, {
        category: category || ''
      }),
      image_url: images && images.length > 0 ? JSON.stringify(images) : "",
      files: files && files.length > 0 ? JSON.stringify(files) : "",
      video_url: video || "",
      collaborators: collab.length > 0 ? JSON.stringify(collab) : ""
    };
  };

  // 發布 或 更新 專案
  const handleAddProject = async e => {
    e.preventDefault();
    if (!newProject.title) return alert("請輸入專案名稱");
    if (uploadingFiles || uploadingVideo) return alert("檔案上傳中，請稍候再送出");
    setSubmitting(true);
    try {
      if (editingProjectId) {
        const original = projects.find(p => p.id === editingProjectId);
        if (original && !canManageProject(original)) {
          alert("僅發布者本人可編輯此專案");
          setSubmitting(false);
          return;
        }
        const updates = {
          ...buildProjectPayload(newProject),
          launch_date: newProject.status === "上線" ? original && original.launch_date && original.launch_date !== "-" ? original.launch_date : new Date().toLocaleDateString() : original?.launch_date || "-"
        };
        if (supabase) {
          const {
            data,
            error
          } = await supabase.from('projects').update(updates).eq('id', editingProjectId).select();
          if (error) {
            alert("更新失敗：" + error.message + "\n\n（若錯誤為找不到 files / video_url / progress 欄位，請先到 Supabase 為 projects 表補上欄位）");
          } else {
            setProjects(projects.map(p => p.id === editingProjectId ? {
              ...p,
              ...updates
            } : p));
            if (original && projectStage(original) !== newProject.status) {
              insertComment(editingProjectId, `狀態由「${projectStage(original)}」變更為「${newProject.status}」`, 'system').catch(() => {});
            }
            handleCloseProjectModal();
            alert("✅ 已更新專案");
          }
        } else {
          setProjects(projects.map(p => p.id === editingProjectId ? {
            ...p,
            ...updates
          } : p));
          if (original && projectStage(original) !== newProject.status) {
            insertComment(editingProjectId, `狀態由「${projectStage(original)}」變更為「${newProject.status}」`, 'system').catch(() => {});
          }
          handleCloseProjectModal();
          alert("✅ (本地模擬) 已更新專案");
        }
      } else {
        const item = {
          ...buildProjectPayload(newProject),
          author: newProject.author || currentUser.name,
          start_date: new Date().toLocaleDateString(),
          launch_date: newProject.status === "上線" ? new Date().toLocaleDateString() : "-"
        };
        if (supabase) {
          const {
            data,
            error
          } = await supabase.from('projects').insert([item]).select();
          if (error) {
            alert("發布失敗，請查看 Supabase 欄位是否齊全：" + error.message);
          } else if (data) {
            setProjects([data[0], ...projects]);
            handleCloseProjectModal();
            alert("🎉 發布成功！");
          }
        } else {
          setProjects([{
            id: Date.now(),
            ...item
          }, ...projects]);
          handleCloseProjectModal();
          alert("🎉 (本地模擬) 發布成功！");
        }
      }
    } catch (err) {
      alert("連線發送失敗，請確認 Supabase 網址與 Key 是否正確！\n" + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // 從公開網址反推 Storage 內的檔案路徑（供刪除用）
  const storagePathFromUrl = url => {
    const marker = `/${STORAGE_BUCKET}/`;
    const i = url.indexOf(marker);
    return i >= 0 ? decodeURIComponent(url.slice(i + marker.length)) : null;
  };

  // 刪除專案（僅發布者本人）
  const handleDeleteProject = async item => {
    if (!canManageProject(item)) {
      alert("僅發布者本人可刪除此專案");
      return;
    }
    if (!confirm(`確定要刪除專案「${item.title}」嗎？此動作無法復原。`)) return;
    try {
      if (supabase) {
        const {
          error
        } = await supabase.from('projects').delete().eq('id', item.id);
        if (error) {
          alert("刪除失敗：" + error.message);
          return;
        }
        // 一併刪除留言與 Storage 上的附件（失敗不影響主要流程）
        try {
          await supabase.from('comments').delete().eq('project_id', item.id);
        } catch (e) {}
        try {
          const urls = [...parseFiles(item.files).map(f => f.url), item.video_url].filter(Boolean);
          const paths = urls.map(storagePathFromUrl).filter(Boolean);
          if (paths.length) await supabase.storage.from(STORAGE_BUCKET).remove(paths);
        } catch (e) {}
      }
      setProjects(projects.filter(p => p.id !== item.id));
      setComments(prev => prev.filter(c => c.project_id !== item.id));
      if (viewingProjectId === item.id) setViewingProjectId(null);
    } catch (err) {
      alert("刪除失敗，請確認連線是否正常！\n" + err.message);
    }
  };

  // 依成員名稱取得其所屬單位（找不到則回傳第一個選項）
  const unitOfMember = name => {
    const u = users.find(x => x.name === name);
    return unitOfUser(u) || UNIT_OPTIONS[0];
  };
  const membersInUnit = unit => users.filter(user => unitOfUser(user) === unit);

  // 快速切換專案狀態（詳情頁一鍵操作，僅本人；會自動寫入系統紀錄）
  const handleQuickStatusChange = async (item, newStatus) => {
    if (!canManageProject(item) || projectStage(item) === newStatus) return;
    const updates = {
      status: storageStatus(newStatus),
      progress: packProgress(item.progress, {
        category: projectMeta(item).category || ''
      }),
      launch_date: newStatus === "上線" ? item.launch_date && item.launch_date !== "-" ? item.launch_date : new Date().toLocaleDateString() : item.launch_date || "-"
    };
    try {
      if (supabase) {
        const {
          error
        } = await supabase.from('projects').update(updates).eq('id', item.id);
        if (error) {
          alert("狀態更新失敗：" + error.message);
          return;
        }
      }
      setProjects(prev => prev.map(p => p.id === item.id ? {
        ...p,
        ...updates
      } : p));
      insertComment(item.id, `狀態由「${projectStage(item)}」變更為「${newStatus}」`, 'system').catch(() => {});
    } catch (err) {
      alert("狀態更新失敗：" + err.message);
    }
  };
  const resetProjectForm = () => {
    setNewProject({
      title: "",
      type: "小工具",
      dept: "JJ",
      author: "",
      status: "開發測試中",
      link: "",
      images: [],
      files: [],
      video: "",
      collaborators: [],
      ai_tools: "",
      pain_point: "",
      target: "",
      solution: "",
      progress: "",
      view_password: "",
      ...EXTRA_DEFAULTS
    });
  };
  const DEFAULT_PASSWORD = "123456";

  // 新增成員帳號（BOSS / ADMIN）
  const handleAddUser = async e => {
    e.preventDefault();
    if (!canAccessAccounts(currentUser)) return alert("僅主管或管理員可新增成員帳號");
    if (!newUser.name || !newUser.account) {
      return alert("請填寫暱稱與帳號");
    }
    if (!ACCOUNT_REGEX.test(newUser.account)) {
      return alert("帳號格式錯誤：需為英文字母＋數字組合（例如 user01）");
    }
    if (users.some(u => u.account === newUser.account)) {
      return alert("此帳號已被使用，請更換其他帳號");
    }
    const shift = newUser.unit.includes('-') ? newUser.unit.split('-')[1] : '早';
    if (supabase) {
      const userItem = {
        ...newUser,
        password: DEFAULT_PASSWORD,
        shift,
        status: 'active'
      };
      const {
        data,
        error
      } = await supabase.from('profiles').insert([userItem]).select();
      if (error) {
        alert("新增失敗：" + error.message);
      } else if (data) {
        setUsers([...users, data[0]]);
        setShowUserModal(false);
        setNewUser({
          name: "",
          account: "",
          password: "",
          email: "",
          role: "MEMBER",
          unit: "JJ-早",
          shift: "早"
        });
        alert(`🎉 成員帳號新增成功！\n預設密碼為 ${DEFAULT_PASSWORD}，請提醒對方登入後自行修改。`);
      }
    } else {
      const userItem = {
        ...newUser,
        password: DEFAULT_PASSWORD,
        shift,
        status: 'active'
      };
      setUsers([...users, {
        id: String(users.length + 1),
        ...userItem
      }]);
      setShowUserModal(false);
      setNewUser({
        name: "",
        account: "",
        password: "",
        email: "",
        role: "MEMBER",
        unit: "JJ-早",
        shift: "早"
      });
      alert(`🎉 (本地模擬) 成員帳號新增成功！預設密碼 ${DEFAULT_PASSWORD}`);
    }
  };

  // 停用 / 啟用
  const handleToggleUserStatus = async u => {
    if (!canManageAccount(currentUser, u)) return alert("您沒有權限管理此帳號");
    if (u.account === currentUser.account) return alert("不能停用自己的帳號");
    const isDisabled = u.status === 'disabled';
    const nextStatus = isDisabled ? 'active' : 'disabled';
    const actionText = isDisabled ? '啟用' : '停用';
    if (!confirm(`確定要${actionText}帳號「${u.name}（${u.account}）」嗎？`)) return;
    try {
      if (supabase) {
        const {
          error
        } = await supabase.from('profiles').update({
          status: nextStatus
        }).eq('id', u.id);
        if (error) {
          alert(`${actionText}失敗：` + error.message);
          return;
        }
      }
      setUsers(users.map(x => x.id === u.id ? {
        ...x,
        status: nextStatus
      } : x));
      alert(`✅ 已${actionText}帳號「${u.name}」`);
    } catch (err) {
      alert(`${actionText}失敗，請確認連線是否正常！\n` + err.message);
    }
  };

  // 開啟編輯成員彈窗
  const handleOpenEditUser = u => {
    if (!canManageAccount(currentUser, u)) return alert("您沒有權限編輯此帳號");
    setEditUserTarget(u);
    setEditUserForm({
      name: u.name || "",
      role: u.role || "MEMBER",
      unit: UNIT_OPTIONS.includes(u.unit) ? u.unit : "JJ-早",
      password: ""
    });
  };

  // 儲存成員編輯
  const handleSaveEditUser = async e => {
    e.preventDefault();
    if (!editUserTarget) return;
    if (!canManageAccount(currentUser, editUserTarget)) return alert("您沒有權限編輯此帳號");
    const newName = editUserForm.name.trim();
    if (!newName) return alert("暱稱不可為空");
    if (editUserForm.password && !PASSWORD_REGEX.test(editUserForm.password)) {
      return alert("密碼格式錯誤：需為 6 位數字（留空則不變更）");
    }
    // 管理員不能指派 BOSS（只有 BOSS 能指派 BOSS）
    if (currentUser.role === "ADMIN" && editUserForm.role === "BOSS") {
      return alert("只有 BOSS 能指派 BOSS 權限");
    }
    // 主管不能把自己降級（避免系統失去唯一主管而無法管理）
    if (isBoss(currentUser) && editUserTarget.account === currentUser.account && editUserForm.role !== "BOSS") {
      if (!users.some(u => u.role === "BOSS" && u.account !== currentUser.account)) {
        return alert("目前只有您一位主管，請先指派另一位主管，才能變更自己的角色");
      }
    }
    const shift = editUserForm.unit.includes('-') ? editUserForm.unit.split('-')[1] : '早';
    const updates = {
      name: newName,
      role: editUserForm.role,
      unit: editUserForm.unit,
      shift
    };
    if (editUserForm.password) {
      updates.password = supabase ? await hashPassword(editUserForm.password) : editUserForm.password;
    }
    const oldName = editUserTarget.name;
    const nameChanged = oldName !== newName;
    setEditUserSaving(true);
    try {
      if (supabase) {
        const {
          error
        } = await supabase.from('profiles').update(updates).eq('id', editUserTarget.id);
        if (error) {
          alert("儲存失敗：" + error.message);
          setEditUserSaving(false);
          return;
        }
        if (nameChanged) {
          const {
            error: projErr
          } = await supabase.from('projects').update({
            author: newName
          }).eq('author', oldName);
          if (projErr) console.error("同步專案負責人失敗：", projErr);
        }
      }
      setUsers(users.map(x => x.id === editUserTarget.id ? {
        ...x,
        ...updates
      } : x));
      if (nameChanged) {
        setProjects(projects.map(p => p.author === oldName ? {
          ...p,
          author: newName
        } : p));
        if (editUserTarget.account === currentUser.account) {
          const updatedSelf = {
            ...currentUser,
            name: newName
          };
          setCurrentUser(updatedSelf);
          writeSession(updatedSelf);
        }
      }
      setEditUserTarget(null);
      alert("✅ 已儲存成員資料");
    } catch (err) {
      alert("儲存失敗，請確認連線是否正常！\n" + err.message);
    } finally {
      setEditUserSaving(false);
    }
  };

  // 刪除成員帳號
  const handleDeleteUser = async u => {
    if (!canManageAccount(currentUser, u)) return alert("您沒有權限刪除此帳號");
    if (u.account === currentUser.account) return alert("不能刪除自己的帳號");
    if (projects.some(p => p.author === u.name)) {
      return alert(`「${u.name}」仍是某些專案的負責人，無法刪除。\n請先請本人處理其專案（可改用「停用」）。`);
    }
    if (!confirm(`確定要刪除帳號「${u.name}（${u.account}）」嗎？此動作無法復原。`)) return;
    try {
      if (supabase) {
        const {
          error
        } = await supabase.from('profiles').delete().eq('id', u.id);
        if (error) {
          alert("刪除失敗：" + error.message);
          return;
        }
      }
      setUsers(users.filter(x => x.id !== u.id));
      setEditUserTarget(null);
      alert(`✅ 已刪除帳號「${u.name}」`);
    } catch (err) {
      alert("刪除失敗，請確認連線是否正常！\n" + err.message);
    }
  };

  // ===== 留言與更新紀錄 =====
  const insertComment = async (projectId, content, kind) => {
    const item = {
      project_id: projectId,
      author: currentUser ? currentUser.name : "",
      content,
      kind,
      created_at: new Date().toISOString()
    };
    if (supabase) {
      const {
        data,
        error
      } = await supabase.from('comments').insert([item]).select();
      if (error) throw error;
      if (data) setComments(prev => [...prev, data[0]]);
    } else {
      setComments(prev => [...prev, {
        id: Date.now(),
        ...item
      }]);
    }
  };
  const handlePostComment = async () => {
    const content = newComment.trim();
    if (!content || !viewingProject) return;
    setPostingComment(true);
    try {
      await insertComment(viewingProject.id, content, 'comment');
      setNewComment("");
    } catch (err) {
      alert("留言失敗：" + err.message);
    } finally {
      setPostingComment(false);
    }
  };
  const canDeleteComment = c => {
    if (!currentUser) return false;
    return c.author === currentUser.name || canAccessAccounts(currentUser);
  };
  const handleDeleteComment = async c => {
    if (!canDeleteComment(c)) return;
    if (!confirm("確定要刪除這則紀錄嗎？")) return;
    try {
      if (supabase) {
        const {
          error
        } = await supabase.from('comments').delete().eq('id', c.id);
        if (error) {
          alert("刪除失敗：" + error.message);
          return;
        }
      }
      setComments(prev => prev.filter(x => x.id !== c.id));
    } catch (err) {
      alert("刪除失敗：" + err.message);
    }
  };
  const formatTime = t => {
    if (!t) return "";
    try {
      return new Date(t).toLocaleString('zh-TW', {
        hour12: false
      });
    } catch (e) {
      return String(t);
    }
  };

  // ===== 專案搜尋 / 篩選 / 排序 =====
  const filteredProjects = useMemo(() => {
    const kw = searchText.trim().toLowerCase();
    const myName = currentUser ? currentUser.name : "";
    let list = projects.filter(p => {
      if (onlyMine && !(p.author === myName || parseCollab(p.collaborators).includes(myName))) return false;
      if (filterStatus !== "全部" && projectStage(p) !== filterStatus) return false;
      if (filterAuthor !== "全部" && p.author !== filterAuthor) return false;
      if (filterType !== "全部" && p.type !== filterType) return false;
      if (filterShift !== "全部") {
        const au = users.find(u => u.name === p.author);
        const shiftUnit = au ? UNIT_OPTIONS.includes(au.unit) ? au.unit : `${getBaseUnit(au)}-${getShift(au) || '早'}` : "";
        if (shiftUnit !== filterShift) return false;
      }
      if (kw) {
        const hay = [p.title, p.author, p.dept, p.pain_point, p.target, p.solution, cleanProgress(p.progress), p.ai_tools, projectMeta(p).category].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    const commentCount = id => comments.filter(c => c.project_id === id).length;
    const statusOrder = Object.fromEntries(STATUS_LIST.map((s, i) => [s, i]));
    list = [...list].sort((a, b) => {
      if (sortBy === "最舊") return a.id > b.id ? 1 : -1;
      if (sortBy === "最多留言") return commentCount(b.id) - commentCount(a.id);
      if (sortBy === "依狀態") return statusOrder[projectStage(a)] - statusOrder[projectStage(b)] || (b.id > a.id ? 1 : -1);
      if (sortBy === "名稱") return String(a.title).localeCompare(String(b.title), 'zh-Hant');
      return b.id > a.id ? 1 : -1; // 最新（預設）
    });
    return list;
  }, [projects, comments, searchText, filterStatus, filterAuthor, filterType, filterShift, sortBy, onlyMine, currentUser, users]);
  const hasActiveFilter = searchText.trim() !== "" || filterStatus !== "全部" || filterAuthor !== "全部" || filterType !== "全部" || filterShift !== "全部" || onlyMine || sortBy !== "最新";
  const clearFilters = () => {
    setSearchText("");
    setFilterStatus("全部");
    setFilterAuthor("全部");
    setFilterType("全部");
    setFilterShift("全部");
    setOnlyMine(false);
    setSortBy("最新");
  };

  // ===== 單位成員統計 =====
  const memberStats = useMemo(() => {
    const list = users.filter(u => u.role !== "BOSS").map(u => {
      // 含本人發布 + 列名協作的專案
      const ps = projects.filter(p => (p.author === u.name || parseCollab(p.collaborators).includes(u.name)) && inPeriod(p, memberPeriod));
      const counts = {};
      STATUS_LIST.forEach(s => counts[s] = ps.filter(p => projectStage(p) === s).length);
      return {
        user: u,
        projects: ps,
        counts,
        total: ps.length
      };
    }).sort((a, b) => b.counts["上線"] - a.counts["上線"] || b.total - a.total);
    return list.map((m, i) => ({
      ...m,
      rank: m.user.id
    }));
  }, [users, projects, memberPeriod]);
  const unitGroups = useMemo(() => {
    const groups = {};
    memberStats.forEach(m => {
      const unit = UNIT_OPTIONS.includes(m.user.unit) ? m.user.unit : `${getBaseUnit(m.user)}-${getShift(m.user) || '早'}`;
      if (!groups[unit]) groups[unit] = [];
      groups[unit].push(m);
    });
    Object.keys(groups).forEach(unit => {
      const byCreationOrder = [...groups[unit]].sort((a, b) => a.user.id - b.user.id);
      const localRankMap = {};
      byCreationOrder.forEach((m, i) => {
        localRankMap[m.user.id] = i + 1;
      });
      groups[unit] = groups[unit].map(m => ({
        ...m,
        rank: localRankMap[m.user.id]
      }));
    });
    return groups;
  }, [memberStats]);
  const viewingProject = viewingProjectId != null ? projects.find(p => p.id === viewingProjectId) : null;

  // 是否能免密碼查看：僅限發布者本人與共同研究成員（連 BOSS／ADMIN 也要輸入密碼）
  const canViewWithoutPassword = item => {
    if (!currentUser) return false;
    if (item.author === currentUser.name) return true;
    return parseCollab(item.collaborators).includes(currentUser.name);
  };
  const openProjectDetail = item => {
    if (!viewingProjectId) detailOrigin.current = { tab: currentTab, scrollY: window.scrollY };
    // 有設查看密碼、且非可免密碼者、且尚未解鎖 → 先跳密碼視窗
    if (item.view_password && !canViewWithoutPassword(item) && !unlockedIds.includes(item.id)) {
      setPwPrompt({
        project: item
      });
      setPwInput("");
      setPwError("");
      return;
    }
    setViewingProjectId(item.id);
    setCurrentTab("專案列表");
    window.scrollTo(0, 0);
  };

  // 送出查看密碼
  const submitViewPassword = e => {
    if (e) e.preventDefault();
    if (!pwPrompt) return;
    if (pwInput === pwPrompt.project.view_password) {
      setUnlockedIds(prev => [...prev, pwPrompt.project.id]);
      setViewingProjectId(pwPrompt.project.id);
      setCurrentTab("專案列表");
      setPwPrompt(null);
      setPwInput("");
      setPwError("");
      window.scrollTo(0, 0);
    } else {
      setPwError("密碼錯誤，請再試一次");
    }
  };
  const ThemeToggle = () => /*#__PURE__*/React.createElement("div", {
    className: "theme-switch",
    role: "group",
    "aria-label": "外觀模式"
  }, [["light", "☀ 淺色"], ["dark", "☾ 深色"]].map(([value, label]) => /*#__PURE__*/React.createElement("button", {
    key: value,
    type: "button",
    "aria-pressed": theme === value,
    onClick: () => setTheme(value)
  }, label)));
  const canReadProject = p => !p.view_password || canViewWithoutPassword(p) || unlockedIds.includes(p.id);
  const ProjectRow = ({
    item
  }) => /*#__PURE__*/React.createElement("article", {
    className: `app-card project-row edge-${projectStage(item)}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "min-w-0"
  }, /*#__PURE__*/React.createElement("button", {
    className: "font-bold text-lg t1 text-left",
    onClick: () => openProjectDetail(item)
  }, item.title, item.view_password ? ' 🔒' : ''), /*#__PURE__*/React.createElement("p", {
    className: "project-summary line-clamp-2"
  }, canReadProject(item) ? summaryOf(item) : '受保護的專案，請解鎖後查看用途與做法。'), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 flex-wrap items-center text-xs t3"
  }, /*#__PURE__*/React.createElement("span", {
    className: `meta-chip tag-type-${item.type === '專案' ? '專案' : '工具'}`
  }, item.type || '小工具'), React.createElement("span", {className: "meta-chip"}, projectMeta(item).category || "尚未分類"), /*#__PURE__*/React.createElement("span", null, item.dept, " · ", item.author), item.start_date && /*#__PURE__*/React.createElement("span", null, "啟動 ", item.start_date), item.launch_date && item.launch_date !== '-' && /*#__PURE__*/React.createElement("span", null, "上線 ", item.launch_date))), /*#__PURE__*/React.createElement("div", {
    className: "row-actions"
  }, /*#__PURE__*/React.createElement("span", {
    className: `meta-chip tag-status-${projectStage(item)}`
  }, projectStage(item)), canReadProject(item) && safeLink(item.link) && /*#__PURE__*/React.createElement("a", {
    className: "btn-accent px-3 py-2 rounded-lg text-sm font-bold",
    href: safeLink(item.link),
    target: "_blank",
    rel: "noopener noreferrer"
  }, "開啟工具 ↗"), /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost px-3 py-2 rounded-lg text-sm",
    onClick: () => openProjectDetail(item)
  }, "查看詳情"), canManageProject(item) && /*#__PURE__*/React.createElement("button", {
    className: "btn-ghost px-3 py-2 rounded-lg text-sm",
    onClick: () => handleOpenEditProject(item)
  }, "編輯")));
  // ===== 還原登入狀態中 =====
  if (restoring) {
    return /*#__PURE__*/React.createElement("div", {
      className: "min-h-screen flex items-center justify-center"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-center"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-black text-xl logo px-3 py-1.5 rounded inline-block"
    }, "AI 成果"), /*#__PURE__*/React.createElement("p", {
      className: "t3 text-sm mt-4"
    }, "載入中...")));
  }

  // ===== 登入畫面 =====
  if (!isLoggedIn) {
    return /*#__PURE__*/React.createElement("div", {
      className: "min-h-screen flex items-center justify-center p-4 relative"
    }, /*#__PURE__*/React.createElement("div", {
      className: "absolute top-4 right-4"
    }, /*#__PURE__*/React.createElement(ThemeToggle, null)), /*#__PURE__*/React.createElement("div", {
      className: "w-full max-w-sm"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-center mb-6"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-black text-xl logo px-3 py-1.5 rounded inline-block"
    }, "AI 成果"), /*#__PURE__*/React.createElement("p", {
      className: "t2 text-sm mt-3"
    }, "請登入以管理專案與成員")), sessionNotice && /*#__PURE__*/React.createElement("p", {
      className: "text-xs t2 app-panel rounded-lg px-3 py-2 mb-3 text-center"
    }, "⏰ ", sessionNotice), /*#__PURE__*/React.createElement("form", {
      onSubmit: handleLogin,
      className: "app-card rounded-2xl p-6 space-y-4"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "text-xs t3 block mb-1"
    }, "帳號"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      required: true,
      autoFocus: true,
      className: "w-full p-2.5 rounded-lg app-input text-sm",
      value: loginForm.account,
      onChange: e => setLoginForm({
        ...loginForm,
        account: e.target.value
      }),
      placeholder: "例如：user01"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "text-xs t3 block mb-1"
    }, "密碼"), /*#__PURE__*/React.createElement("input", {
      type: "password",
      required: true,
      inputMode: "numeric",
      maxLength: "6",
      className: "w-full p-2.5 rounded-lg app-input text-sm",
      value: loginForm.password,
      onChange: e => setLoginForm({
        ...loginForm,
        password: e.target.value.replace(/\D/g, '').slice(0, 6)
      }),
      placeholder: "6 位數字"
    })), loginError && /*#__PURE__*/React.createElement("p", {
      className: "text-xs danger app-panel rounded-lg px-3 py-2"
    }, loginError), /*#__PURE__*/React.createElement("button", {
      type: "submit",
      disabled: loggingIn,
      className: "w-full py-2.5 btn-accent font-bold text-sm rounded-lg disabled:opacity-50"
    }, loggingIn ? "登入中..." : "登入")), /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] t3 text-center mt-4"
    }, "閒置超過 4 小時會自動登出"), !isConfigured && /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] t3 text-center mt-2"
    }, "本地模擬模式測試帳號：admin01 / 123456（ADMIN）、usera01 / 111111（MEMBER）")));
  }
  const visibleTabs = canAccessAccounts(currentUser) ? ["總覽", "專案列表", "單位成員", "找工具・學做法", "帳號管理"] : ["總覽", "專案列表", "單位成員", "找工具・學做法"];

  // ===== 總覽統計 =====
  const overview = (() => {
    const total = projects.length;
    const byStatus = {};
    STATUS_LIST.forEach(s => byStatus[s] = projects.filter(p => projectStage(p) === s).length);
    const byType = {
      工具: projects.filter(p => p.type !== '專案').length,
      專案: projects.filter(p => p.type === '專案').length
    };
    const online = byStatus["上線"] || 0;
    const onlineRate = total > 0 ? Math.round(online / total * 100) : 0;
    // 各班別統計
    const byShift = {};
    UNIT_OPTIONS.forEach(u => {
      const ps = projects.filter(p => {
        const author = users.find(x => x.name === p.author);
        return author && (UNIT_OPTIONS.includes(author.unit) ? author.unit : `${getBaseUnit(author)}-${getShift(author) || '早'}`) === u;
      });
      byShift[u] = {
        total: ps.length,
        online: ps.filter(p => projectStage(p) === '上線').length
      };
    });
    // AI 工具使用次數排行
    const toolCount = {};
    projects.forEach(p => {
      [...new Set((p.ai_tools || "").split(/[,，、]/).map(toolName).filter(Boolean))].forEach(t => {
        toolCount[t] = (toolCount[t] || 0) + 1;
      });
    });
    const topTools = Object.entries(toolCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
    // 最近更新
    const recent = [...projects].sort((a, b) => b.id > a.id ? 1 : -1).slice(0, 6);
    const ongoing = projects.filter(p => !['上線', '下線'].includes(projectStage(p))).length;
    const recentOnline = projects.filter(p => {
      const t = Date.parse(p.launch_date);
      return projectStage(p) === '上線' && Number.isFinite(t) && t <= Date.now() && t >= Date.now() - 30 * 86400000;
    }).length;
    return {
      total,
      byStatus,
      byType,
      online,
      onlineRate,
      byShift,
      topTools,
      recent,
      ongoing,
      recentOnline
    };
  })();

  // ===== 匯出 CSV（Excel 可開）=====
  const exportCSV = (scope = "filtered") => {
    const headers = ["專案名稱", "類型", "狀態", "單位", "負責人", "共同研究", "AI工具", "痛點描述", "預期目標", "優化方法", "目前進展", "專案網址", "啟動日", "上線日", "用途分類"];
    const rows = (scope === "all" ? projects : filteredProjects).filter(canReadProject).map(p => [p.title, p.type, projectStage(p), p.dept, p.author, parseCollab(p.collaborators).join('、'), p.ai_tools, p.pain_point, p.target, p.solution, cleanProgress(p.progress), p.link, p.start_date, p.launch_date, projectMeta(p).category]);
    const esc = v => {
      let text = String(v == null ? "" : v);
      if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csv = "\uFEFF" + [headers, ...rows].map(r => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `AI專案清單_${new Date().toLocaleDateString('zh-TW').replace(/\//g, '')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "min-h-screen"
  }, /*#__PURE__*/React.createElement("nav", {
    className: "dashboard-nav app-card border-x-0 border-t-0 rounded-none px-6 py-3 flex flex-wrap gap-y-2 items-center justify-between sticky top-0 z-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-6 flex-wrap"
  }, /*#__PURE__*/React.createElement("span", {
    className: "font-black text-xl logo px-3 py-1.5 rounded"
  }, "AI 成果"), /*#__PURE__*/React.createElement("div", {
    className: "dashboard-tabs flex gap-2 flex-wrap"
  }, visibleTabs.map(tab => /*#__PURE__*/React.createElement("button", {
    key: tab,
    "aria-current": currentTab === tab ? "page" : undefined,
    onClick: () => {
      setCurrentTab(tab);
      setViewingProjectId(null);
    },
    className: `px-4 py-1.5 rounded-full font-semibold text-sm transition-all ${currentTab === tab && !viewingProject ? 'navpill-active' : 'navpill'}`
  }, tab)))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3 flex-wrap"
  }, /*#__PURE__*/React.createElement(ThemeToggle, null), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setShowMyPwModal(true);
      setMyPwForm({
        oldPw: "",
        newPw: "",
        confirmPw: ""
      });
      setMyPwError("");
    },
    className: "btn-ghost px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5",
    title: "點此修改我的密碼"
  }, /*#__PURE__*/React.createElement("span", null, "👤 ", currentUser.name, "（", roleLabel(currentUser.role), "）"), /*#__PURE__*/React.createElement("span", {
    className: "accent"
  }, "🔑 改密碼")), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setNewProject(prev => ({
        ...prev,
        dept: unitOfMember(currentUser.name)
      }));
      setShowProjectModal(true);
    },
    className: "btn-accent font-bold px-4 py-2 rounded-xl text-sm transition-all"
  }, "+ 發布 AI 專案"), /*#__PURE__*/React.createElement("button", {
    onClick: handleLogout,
    className: "btn-danger px-3 py-2 rounded-xl text-sm font-semibold transition-all"
  }, "登出"))), currentTab === "總覽" && /*#__PURE__*/React.createElement("div", {
    className: "p-6 max-w-7xl mx-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-6 flex items-end justify-between flex-wrap gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "page-eyebrow mb-1"
  }, "DASHBOARD"), /*#__PURE__*/React.createElement("h1", {
    className: "page-title mb-1"
  }, "總覽", /*#__PURE__*/React.createElement("span", {
    className: "accent"
  }, ".")), /*#__PURE__*/React.createElement("p", {
    className: "page-sub"
  }, "從團隊成果出發，找到下一個值得使用的工具與做法。")), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportCSV("all"),
    className: "btn-ghost px-4 py-2.5 rounded-lg text-sm font-bold"
  }, "⬇ 匯出專案清單 (Excel)")), React.createElement("section", {className: "dashboard-welcome"},
    React.createElement("div", null,
      React.createElement("p", {className: "page-eyebrow"}, "TEAM WORKSPACE"),
      React.createElement("h2", null, currentUser.name + "，一起讓好點子成為成果。"),
      React.createElement("p", null, "瀏覽團隊專案、追蹤開發進度，或從已上線的工具開始。")),
    React.createElement("div", {className: "dashboard-shortcuts"},
      React.createElement("button", {className: "btn-accent", onClick: () => {clearFilters(); setViewingProjectId(null); setCurrentTab("專案列表");}}, "瀏覽全部專案 →"),
      React.createElement("button", {className: "btn-ghost", onClick: () => {clearFilters(); setFilterStatus("上線"); setViewingProjectId(null); setCurrentTab("專案列表");}}, "查看已上線成果"))), /*#__PURE__*/React.createElement("div", {
    className: "dashboard-metrics grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm t3 font-semibold mb-1"
  }, "總專案數"), /*#__PURE__*/React.createElement("div", {
    className: "text-4xl font-black t1"
  }, overview.total), /*#__PURE__*/React.createElement("div", {
    className: "text-xs t3 mt-1"
  }, "工具 ", overview.byType.工具, "・專案 ", overview.byType.專案)), /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5 edge-上線"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm t3 font-semibold mb-1"
  }, "已上線"), /*#__PURE__*/React.createElement("div", {
    className: "text-4xl font-black accent"
  }, overview.online), /*#__PURE__*/React.createElement("div", {
    className: "text-xs t3 mt-1"
  }, "上線率 ", overview.onlineRate, "%")), /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5 edge-開發測試中"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm t3 font-semibold mb-1"
  }, "進行中"), /*#__PURE__*/React.createElement("div", {
    className: "text-4xl font-black t1"
  }, overview.ongoing), /*#__PURE__*/React.createElement("div", {
    className: "text-xs t3 mt-1"
  }, "規劃與開發測試中")), /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5 edge-下線"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-sm t3 font-semibold mb-1"
  }, "已下線"), /*#__PURE__*/React.createElement("div", {
    className: "text-4xl font-black t1"
  }, overview.byStatus["下線"]), /*#__PURE__*/React.createElement("div", {
    className: "text-xs t3 mt-1"
  }, "停用的專案"))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "font-bold t1 mb-4"
  }, "狀態分布"), /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, STATUS_LIST.map(s => {
    const n = overview.byStatus[s];
    const pct = overview.total > 0 ? Math.round(n / overview.total * 100) : 0;
    return /*#__PURE__*/React.createElement("div", {
      key: s
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between text-xs mb-1"
    }, /*#__PURE__*/React.createElement("span", {
      className: `px-2 py-0.5 rounded-full font-semibold tag-status-${s}`
    }, s), /*#__PURE__*/React.createElement("span", {
      className: "t2 font-semibold"
    }, n, " 個・", pct, "%")), /*#__PURE__*/React.createElement("div", {
      className: "h-2.5 rounded-full overflow-hidden",
      style: {
        background: 'var(--input)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: `h-full bar-${s === '開發測試中' ? 'target' : s === '上線' ? 'solution' : 'pain'}`,
      style: {
        width: pct + '%'
      }
    })));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "font-bold t1 mb-4"
  }, "各班別產出"), /*#__PURE__*/React.createElement("div", {
    className: "space-y-3"
  }, UNIT_OPTIONS.map(u => {
    const d = overview.byShift[u];
    const maxTotal = Math.max(1, ...UNIT_OPTIONS.map(x => overview.byShift[x].total));
    return /*#__PURE__*/React.createElement("div", {
      key: u
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex justify-between text-xs mb-1"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-bold t1"
    }, u), /*#__PURE__*/React.createElement("span", {
      className: "t2 font-semibold"
    }, d.total, " 個（上線 ", d.online, "）")), /*#__PURE__*/React.createElement("div", {
      className: "h-2.5 rounded-full overflow-hidden",
      style: {
        background: 'var(--input)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "h-full bar-solution",
      style: {
        width: d.total / maxTotal * 100 + '%'
      }
    })));
  })))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 lg:grid-cols-2 gap-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "font-bold t1 mb-4"
  }, "🤖 AI 工具使用排行"), overview.topTools.length === 0 ? /*#__PURE__*/React.createElement("p", {
    className: "text-sm t3"
  }, "尚無資料（發布專案時填寫「使用的 AI 工具」即會統計）") : /*#__PURE__*/React.createElement("div", {
    className: "space-y-2.5"
  }, overview.topTools.map(([name, n]) => {
    const max = overview.topTools[0][1];
    return /*#__PURE__*/React.createElement("div", {
      key: name,
      className: "flex items-center gap-3"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-sm t1 font-semibold w-28 shrink-0 truncate"
    }, name), /*#__PURE__*/React.createElement("div", {
      className: "flex-1 h-5 rounded-md overflow-hidden",
      style: {
        background: 'var(--input)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "h-full bar-solution",
      style: {
        width: n / max * 100 + '%'
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "text-sm t2 font-bold w-8 text-right"
    }, n));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-5"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "font-bold t1 mb-4"
  }, "🕒 最近發布"), overview.recent.length === 0 ? /*#__PURE__*/React.createElement("p", {
    className: "text-sm t3"
  }, "尚無專案") : /*#__PURE__*/React.createElement("ul", {
    className: "divide-y divide-[var(--border)]"
  }, overview.recent.map(p => /*#__PURE__*/React.createElement("li", {
    key: p.id,
    onClick: () => openProjectDetail(p),
    className: "py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:opacity-75 px-2 -mx-2 rounded transition-opacity"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 min-w-0"
  }, /*#__PURE__*/React.createElement("span", {
    className: `text-[11px] shrink-0 px-2 py-0.5 rounded font-semibold tag-type-${p.type === '專案' ? '專案' : '工具'}`
  }, p.type === '專案' ? '專案' : '工具'), /*#__PURE__*/React.createElement("span", {
    className: "text-sm t1 font-semibold truncate"
  }, p.title)), /*#__PURE__*/React.createElement("span", {
    className: `shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold tag-status-${projectStage(p)}`
  }, projectStage(p)))))))), currentTab === "專案列表" && viewingProject && (() => {
    const detailImages = parseImages(viewingProject.image_url);
    const detailFiles = parseFiles(viewingProject.files);
    return /*#__PURE__*/React.createElement("div", {
      className: "p-6 max-w-5xl mx-auto"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mb-6"
    }, /*#__PURE__*/React.createElement("div", {
      className: "page-eyebrow mb-1"
    }, "DASHBOARD"), /*#__PURE__*/React.createElement("h1", {
      className: "page-title mb-1"
    }, "專案詳情", /*#__PURE__*/React.createElement("span", {
      className: "accent"
    }, ".")), /*#__PURE__*/React.createElement("p", {
      className: "page-sub"
    }, "深入了解這個專案的來龍去脈與成效")), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setViewingProjectId(null);
        setCurrentTab(detailOrigin.current.tab);
        requestAnimationFrame(() => window.scrollTo(0, detailOrigin.current.scrollY));
      },
      className: "detail-back-button mb-5"
    }, "← 返回" + detailOrigin.current.tab), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center justify-between gap-3 mb-2"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-3 flex-wrap"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "text-3xl font-black t1"
    }, viewingProject.title), /*#__PURE__*/React.createElement("span", {
      className: `px-2.5 py-0.5 rounded-full text-xs font-semibold tag-type-${viewingProject.type === '專案' ? '專案' : '工具'}`
    }, viewingProject.type || '小工具'), /*#__PURE__*/React.createElement("span", {
      className: `px-3 py-1 rounded-full text-xs font-semibold tag-status-${projectStage(viewingProject)}`
    }, "● ", projectStage(viewingProject))), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2"
    }, viewingProject.link && /*#__PURE__*/React.createElement("a", {
      href: safeLink(viewingProject.link),
      target: "_blank",
      rel: "noopener noreferrer",
      className: "btn-accent font-bold px-4 py-2 rounded-xl text-sm"
    }, "開啟工具 ↗"), canManageProject(viewingProject) && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      onClick: () => handleOpenEditProject(viewingProject),
      className: "text-sm btn-ghost px-3 py-2 rounded-xl"
    }, "✏️ 編輯"), /*#__PURE__*/React.createElement("button", {
      onClick: () => handleDeleteProject(viewingProject),
      className: "text-sm btn-danger px-3 py-2 rounded-xl"
    }, "🗑️ 刪除")))), /*#__PURE__*/React.createElement("p", {
      className: "text-sm t2 mb-3"
    }, "負責人 ", viewingProject.dept || 'JJ', "・", /*#__PURE__*/React.createElement("span", {
      className: "owner-name text-base"
    }, viewingProject.author), parseCollab(viewingProject.collaborators).length > 0 && /*#__PURE__*/React.createElement("span", null, " ・ 🤝 共同研究：", parseCollab(viewingProject.collaborators).join('、')), viewingProject.start_date && /*#__PURE__*/React.createElement("span", null, " ・ 啟動於 ", viewingProject.start_date), viewingProject.launch_date && viewingProject.launch_date !== "-" && /*#__PURE__*/React.createElement("span", null, " ・ 上線於 ", viewingProject.launch_date)), canManageProject(viewingProject) && /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1.5 mb-5 flex-wrap"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-xs t3 mr-1"
    }, "快速切換狀態："), STATUS_LIST.map(s => /*#__PURE__*/React.createElement("button", {
      key: s,
      onClick: () => handleQuickStatusChange(viewingProject, s),
      className: `px-3 py-1 rounded-full text-xs font-semibold transition-all ${projectStage(viewingProject) === s ? 'btn-accent' : `tag-status-${s} opacity-60 hover:opacity-100`}`
    }, s))), /*#__PURE__*/React.createElement("div", {
      className: "mb-4"
    }, /*#__PURE__*/React.createElement("span", {
      className: "meta-chip"
    }, "用途分類：", projectMeta(viewingProject).category || '尚未分類')), /*#__PURE__*/React.createElement("div", {
      className: "app-card rounded-2xl p-6 space-y-6"
    }, usefulText(viewingProject.pain_point) && /*#__PURE__*/React.createElement("div", {
      className: "flex gap-4"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-1 rounded bar-pain shrink-0"
    }), /*#__PURE__*/React.createElement("div", {
      className: "flex-1"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm sec-pain mb-2"
    }, "🚨 想解決什麼（痛點描述）"), /*#__PURE__*/React.createElement("p", {
      className: "text-sm t1 whitespace-pre-wrap leading-relaxed"
    }, viewingProject.pain_point || "無"))), usefulText(viewingProject.target) && /*#__PURE__*/React.createElement("div", {
      className: "flex gap-4"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-1 rounded bar-target shrink-0"
    }), /*#__PURE__*/React.createElement("div", {
      className: "flex-1"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm sec-target mb-2"
    }, "🎯 預期目標"), /*#__PURE__*/React.createElement("p", {
      className: "text-sm t1 whitespace-pre-wrap leading-relaxed"
    }, viewingProject.target || "無"))), usefulText(viewingProject.solution) && /*#__PURE__*/React.createElement("div", {
      className: "flex gap-4"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-1 rounded bar-solution shrink-0"
    }), /*#__PURE__*/React.createElement("div", {
      className: "flex-1"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm sec-solution mb-2"
    }, "⚡ 我們怎麼做（優化方法）"), /*#__PURE__*/React.createElement("p", {
      className: "text-sm t1 whitespace-pre-wrap leading-relaxed"
    }, viewingProject.solution || "無"))), usefulText(cleanProgress(viewingProject.progress)) && /*#__PURE__*/React.createElement("div", {
      className: "flex gap-4"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-1 rounded bar-progress shrink-0"
    }), /*#__PURE__*/React.createElement("div", {
      className: "flex-1"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm sec-progress mb-2"
    }, "📈 目前進展"), (() => {
      const items = splitProgress(cleanProgress(viewingProject.progress));
      if (items.length === 0) return /*#__PURE__*/React.createElement("p", {
        className: "text-sm t1"
      }, "無");
      if (items.length === 1) return /*#__PURE__*/React.createElement("p", {
        className: "text-sm t1 whitespace-pre-wrap leading-relaxed"
      }, items[0]);
      return /*#__PURE__*/React.createElement("ul", {
        className: "space-y-1.5"
      }, items.map((line, i) => /*#__PURE__*/React.createElement("li", {
        key: i,
        className: "text-sm t1 leading-relaxed flex gap-2"
      }, /*#__PURE__*/React.createElement("span", {
        className: "sec-progress shrink-0"
      }, "•"), /*#__PURE__*/React.createElement("span", {
        className: "whitespace-pre-wrap"
      }, line))));
    })())), viewingProject.ai_tools && /*#__PURE__*/React.createElement("div", {
      className: "pt-2 border-t bd"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm t3 mb-2"
    }, "🤖 使用的 AI 工具"), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap gap-1.5"
    }, viewingProject.ai_tools.split(/[,，、]/).map(t => t.trim()).filter(Boolean).map((t, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      className: "px-2.5 py-1 rounded-full text-xs font-semibold btn-accent-soft"
    }, t)))), detailFiles.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "pt-2 border-t bd"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm t3 mb-2"
    }, "📎 相關文件"), /*#__PURE__*/React.createElement("ul", {
      className: "space-y-2"
    }, detailFiles.map((f, i) => /*#__PURE__*/React.createElement("li", {
      key: i,
      className: "flex items-center justify-between gap-3 app-panel rounded-lg px-3 py-2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-sm t1 truncate"
    }, "📄 ", f.name), /*#__PURE__*/React.createElement("span", {
      className: "flex items-center gap-2 shrink-0"
    }, /*#__PURE__*/React.createElement("a", {
      href: f.url,
      target: "_blank",
      rel: "noopener noreferrer",
      className: "text-xs link hover:underline"
    }, "線上開啟"), /*#__PURE__*/React.createElement("a", {
      href: downloadUrl(f.url, f.name),
      className: "text-xs btn-accent-soft px-3 py-1.5 rounded-md font-bold"
    }, "⬇ 下載"))))), /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] t3 mt-2"
    }, "txt 檔線上開啟若顯示亂碼，請改用「下載」，存到電腦後開啟即為正常內容")), viewingProject.video_url && /*#__PURE__*/React.createElement("div", {
      className: "pt-2 border-t bd"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm t3 mb-2"
    }, "🎬 操作教學影片"), /*#__PURE__*/React.createElement("video", {
      src: viewingProject.video_url,
      controls: true,
      className: "w-full max-h-[420px] rounded-lg border bd bg-black"
    })), detailImages.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "pt-2 border-t bd"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm t3 mb-2"
    }, "📷 成果展示（點圖可放大）"), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap gap-3"
    }, detailImages.map((img, i) => /*#__PURE__*/React.createElement("img", {
      key: i,
      src: img,
      alt: `成果展示 ${i + 1}`,
      onClick: () => { setLightboxZoom(1); setLightboxSize(null); setLightboxUrl(img); },
      className: "max-h-72 rounded-lg border bd object-contain cursor-zoom-in hover:opacity-90 transition-opacity"
    }))))), /*#__PURE__*/React.createElement("div", {
      className: "app-card rounded-2xl p-6 mt-4"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "font-bold text-sm t1 mb-4"
    }, "💬 留言與更新紀錄", /*#__PURE__*/React.createElement("span", {
      className: "t3 font-normal ml-1"
    }, "(", comments.filter(c => c.project_id === viewingProject.id).length, ")")), /*#__PURE__*/React.createElement("div", {
      className: "flex gap-2 mb-5"
    }, /*#__PURE__*/React.createElement("input", {
      type: "text",
      className: "flex-1 p-2.5 rounded-lg app-input text-sm",
      placeholder: "留言或記錄一筆進度更新...（Enter 送出）",
      value: newComment,
      onChange: e => setNewComment(e.target.value),
      onKeyDown: e => {
        if (e.key === 'Enter') handlePostComment();
      }
    }), /*#__PURE__*/React.createElement("button", {
      onClick: handlePostComment,
      disabled: postingComment || !newComment.trim(),
      className: "px-4 py-2 btn-accent font-bold text-sm rounded-lg disabled:opacity-40"
    }, postingComment ? '送出中...' : '送出')), (() => {
      const list = comments.filter(c => c.project_id === viewingProject.id).slice().reverse();
      if (list.length === 0) {
        return /*#__PURE__*/React.createElement("p", {
          className: "text-xs t3 text-center py-4"
        }, "尚無留言，記錄第一筆更新吧");
      }
      return /*#__PURE__*/React.createElement("ul", {
        className: "space-y-3"
      }, list.map(c => /*#__PURE__*/React.createElement("li", {
        key: c.id,
        className: "rounded-lg p-3 app-panel"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center justify-between mb-1"
      }, /*#__PURE__*/React.createElement("span", {
        className: "text-xs font-bold t2"
      }, c.kind === 'system' ? '🔄 系統紀錄' : `💬 ${c.author}`), /*#__PURE__*/React.createElement("span", {
        className: "flex items-center gap-2 text-[11px] t3"
      }, formatTime(c.created_at), canDeleteComment(c) && /*#__PURE__*/React.createElement("button", {
        onClick: () => handleDeleteComment(c),
        className: "danger hover:opacity-70"
      }, "刪除"))), /*#__PURE__*/React.createElement("p", {
        className: `text-sm whitespace-pre-wrap ${c.kind === 'system' ? 't3' : 't1'}`
      }, c.kind === 'system' && c.author ? `${c.author}：` : '', c.content))));
    })()));
  })(), currentTab === "專案列表" && !viewingProject && /*#__PURE__*/React.createElement("div", {
    className: "p-6 max-w-7xl mx-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "page-eyebrow mb-1"
  }, "DASHBOARD"), /*#__PURE__*/React.createElement("h1", {
    className: "page-title mb-1"
  }, "專案列表", /*#__PURE__*/React.createElement("span", {
    className: "accent"
  }, ".")), /*#__PURE__*/React.createElement("p", {
    className: "page-sub"
  }, "搜尋成果、掌握進度，找到能直接使用的工具")), /*#__PURE__*/React.createElement("div", {
    className: "project-filters app-card rounded-xl p-4 mb-4 space-y-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-3"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    className: "flex-1 min-w-[200px] p-2.5 rounded-lg app-input text-sm",
    "aria-label": "搜尋專案名稱、負責人或內容",
    placeholder: "搜尋專案名稱、負責人、內容關鍵字…",
    value: searchText,
    onChange: e => setSearchText(e.target.value)
  }), /*#__PURE__*/React.createElement("select", {
    className: "p-2.5 rounded-lg app-input text-sm",
    "aria-label": "負責人",
    value: filterAuthor,
    onChange: e => setFilterAuthor(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "全部"
  }, "負責人：全部"), users.map(u => /*#__PURE__*/React.createElement("option", {
    key: u.id,
    value: u.name
  }, u.name))), /*#__PURE__*/React.createElement("select", {
    className: "p-2.5 rounded-lg app-input text-sm",
    "aria-label": "專案類型",
    value: filterType,
    onChange: e => setFilterType(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "全部"
  }, "類型：全部"), /*#__PURE__*/React.createElement("option", {
    value: "小工具"
  }, "小工具"), /*#__PURE__*/React.createElement("option", {
    value: "專案"
  }, "專案")), /*#__PURE__*/React.createElement("select", {
    className: "p-2.5 rounded-lg app-input text-sm",
    "aria-label": "班別",
    value: filterShift,
    onChange: e => setFilterShift(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "全部"
  }, "班別：全部"), UNIT_OPTIONS.map(opt => /*#__PURE__*/React.createElement("option", {
    key: opt,
    value: opt
  }, opt))), /*#__PURE__*/React.createElement("select", {
    className: "p-2.5 rounded-lg app-input text-sm",
    "aria-label": "排序方式",
    value: sortBy,
    onChange: e => setSortBy(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "最新"
  }, "排序：最新"), /*#__PURE__*/React.createElement("option", {
    value: "最舊"
  }, "排序：最舊"), /*#__PURE__*/React.createElement("option", {
    value: "最多留言"
  }, "排序：最多留言"), /*#__PURE__*/React.createElement("option", {
    value: "依狀態"
  }, "排序：依狀態"), /*#__PURE__*/React.createElement("option", {
    value: "名稱"
  }, "排序：名稱")), /*#__PURE__*/React.createElement("button", {
    "aria-pressed": onlyMine,
    onClick: () => setOnlyMine(v => !v),
    className: `px-4 py-2.5 rounded-lg text-sm font-bold transition-all ${onlyMine ? 'btn-accent' : 'btn-ghost'}`
  }, "👤 我的專案")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-2"
  }, ["全部", ...STATUS_LIST].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    "aria-pressed": filterStatus === s,
    onClick: () => setFilterStatus(s),
    className: `px-3 py-1 rounded-full text-xs font-semibold transition-colors ${filterStatus === s ? 'btn-accent' : s === "全部" ? 'btn-ghost' : `tag-status-${s} hover:opacity-80`}`
  }, s, s !== "全部" ? ` ${projects.filter(p => projectStage(p) === s).length}` : '')), /*#__PURE__*/React.createElement("span", {
    className: "project-result-count text-xs t3 ml-auto flex items-center gap-2",
    "aria-live": "polite",
    role: "status"
  }, "顯示 ", filteredProjects.length, " / ", projects.length, " 筆", /*#__PURE__*/React.createElement("button", {
    onClick: exportCSV,
    className: "accent hover:underline font-semibold"
  }, "⬇ 匯出"), hasActiveFilter && /*#__PURE__*/React.createElement("button", {
    onClick: clearFilters,
    className: "accent hover:underline"
  }, "清除篩選")))), projects.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-12 text-center t3"
  }, "尚無專案資料，點選右上角「+ 發布 AI 專案」新增") : filteredProjects.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-12 text-center t3"
  }, React.createElement("h2", {className: "empty-title"}, "找不到符合條件的專案"), React.createElement("p", null, "試試其他關鍵字，或清除篩選重新瀏覽。"), React.createElement("button", {className: "btn-accent empty-reset", onClick: clearFilters}, "清除所有篩選")) : /*#__PURE__*/React.createElement("div", {
    className: "space-y-4"
  }, filteredProjects.map(item => /*#__PURE__*/React.createElement(ProjectRow, {
    key: item.id,
    item: item
  })))), currentTab === '找工具・學做法' && (() => {
    const readable = projects.filter(canReadProject);
    const matched = readable.filter(p => {
      const category = projectMeta(p).category || '尚未分類';
      const matchesCategory = catalogCategory === '全部' || category === catalogCategory;
      return matchesCategory && (!catalogAvailable || projectStage(p) === '上線' && safeLink(p.link)) && [p.title, p.author, summaryOf(p), p.solution, p.ai_tools, category].filter(Boolean).join(' ').toLowerCase().includes(catalogQuery.trim().toLowerCase());
    });
    const catalogCategoryOrder = [...CATEGORY_LIST, '尚未分類'];
    const displayedMatched = catalogCategory === '全部' ? [...matched].sort((a, b) => catalogCategoryOrder.indexOf(projectMeta(a).category || '尚未分類') - catalogCategoryOrder.indexOf(projectMeta(b).category || '尚未分類')) : matched;
    return /*#__PURE__*/React.createElement("main", {
      className: "p-6 max-w-7xl mx-auto"
    }, /*#__PURE__*/React.createElement("section", {
      className: "knowledge-hero"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "page-eyebrow mb-1"
    }, "KNOWLEDGE HUB"), /*#__PURE__*/React.createElement("h1", {
      className: "page-title mb-2"
    }, "找工具・學做法", /*#__PURE__*/React.createElement("span", {
      className: "accent"
    }, ".")), /*#__PURE__*/React.createElement("p", {
      className: "page-sub"
    }, "先找到能用的成果，再把同事驗證過的方法帶回自己的工作。")), /*#__PURE__*/React.createElement("ol", {
      className: "knowledge-steps",
      "aria-label": "使用流程"
    }, [["1", "找到相關成果", "按用途快速篩選"], ["2", "查看可複用做法", "理解重點與避坑"], ["3", "開啟工具或聯繫", "直接行動，不繞路"]].map(([no, title, note]) => /*#__PURE__*/React.createElement("li", {
      key: no,
      className: "knowledge-step"
    }, /*#__PURE__*/React.createElement("span", {
      className: "knowledge-step-no"
    }, no), /*#__PURE__*/React.createElement("span", {
      className: "knowledge-step-copy"
    }, /*#__PURE__*/React.createElement("strong", null, title), /*#__PURE__*/React.createElement("span", null, note)))))), /*#__PURE__*/React.createElement("section", {
      className: "app-card catalog-shell",
      "aria-label": "成果搜尋與篩選"
    }, /*#__PURE__*/React.createElement("div", {
      className: "catalog-toolbar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "catalog-mode",
      role: "group",
      "aria-label": "瀏覽模式"
    }, ['找工具', '學做法'].map(v => /*#__PURE__*/React.createElement("button", {
      key: v,
      type: "button",
      "aria-pressed": catalogMode === v,
      onClick: () => setCatalogMode(v)
    }, v))), /*#__PURE__*/React.createElement("input", {
      "aria-label": "搜尋工具與做法",
      className: "app-input catalog-search p-3 rounded-lg flex-1 min-w-[180px]",
      placeholder: "搜尋用途、名稱、負責人或技術…",
      value: catalogQuery,
      onChange: e => setCatalogQuery(e.target.value)
    }), /*#__PURE__*/React.createElement("label", {
      className: "catalog-online flex gap-2 items-center text-sm"
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: catalogAvailable,
      onChange: e => setCatalogAvailable(e.target.checked)
    }), "只看已上線且有連結")), /*#__PURE__*/React.createElement("p", {
      className: "catalog-mode-help"
    }, catalogMode === '找工具' ? '找工具：依需求找到可直接開啟使用的成果，重點看適用情境、狀態與入口。' : '學做法：不一定要使用同一套工具，重點看同事如何解題、採用哪些方法與可複用亮點。'), /*#__PURE__*/React.createElement("div", {
      className: "catalog-filters",
      "aria-label": "用途分類"
    }, ['全部', ...CATEGORY_LIST, '尚未分類'].map(v => /*#__PURE__*/React.createElement("button", {
      key: v,
      type: "button",
      className: "catalog-filter",
      "aria-pressed": catalogCategory === v,
      onClick: () => setCatalogCategory(v)
    }, v, " ", readable.filter(p => v === '全部' || (projectMeta(p).category || '尚未分類') === v).length)))), /*#__PURE__*/React.createElement("div", {
      className: "catalog-results-head"
    }, /*#__PURE__*/React.createElement("h2", null, catalogMode === '找工具' ? '推薦工具' : '值得參考的做法'), /*#__PURE__*/React.createElement("p", null, "找到 ", matched.length, " 項成果", projects.length > readable.length ? ' · 受保護項目請先解鎖' : '')), !matched.length ? /*#__PURE__*/React.createElement("div", {
      className: "app-card p-8 rounded-xl text-center"
    }, /*#__PURE__*/React.createElement("p", {
      className: "t2 mb-4"
    }, "沒有符合條件的成果。"), /*#__PURE__*/React.createElement("button", {
      className: "btn-ghost px-4 py-2 rounded-lg",
      onClick: () => {
        setCatalogQuery('');
        setCatalogCategory('全部');
        setCatalogAvailable(false);
      }
    }, "清除篩選")) : /*#__PURE__*/React.createElement("div", {
      className: "knowledge-list"
    }, displayedMatched.map((p, index) => {
      const tools = p.ai_tools ? [...new Set(p.ai_tools.split(/[,，、]/).map(toolName).filter(Boolean))].slice(0, 3) : [];
      const category = projectMeta(p).category || '尚未分類';
      const highlights = methodHighlightsOf(p);
      const previousCategory = index > 0 ? projectMeta(displayedMatched[index - 1]).category || '尚未分類' : '';
      const showCategoryHeading = catalogCategory === '全部' && category !== previousCategory;
      return [showCategoryHeading && /*#__PURE__*/React.createElement("div", {
        key: `group-${category}`,
        className: "catalog-group-heading"
      }, /*#__PURE__*/React.createElement("h2", null, category), /*#__PURE__*/React.createElement("span", null, displayedMatched.filter(item => (projectMeta(item).category || '尚未分類') === category).length, " 項")), /*#__PURE__*/React.createElement("article", {
        key: p.id,
        className: "app-card knowledge-card"
      }, /*#__PURE__*/React.createElement("div", {
        className: "knowledge-summary"
      }, /*#__PURE__*/React.createElement("div", {
        className: "knowledge-title"
      }, /*#__PURE__*/React.createElement("h3", null, p.title), /*#__PURE__*/React.createElement("span", {
        className: `knowledge-category ${category === '生活' ? 'knowledge-category-life' : ''}`
      }, category)), /*#__PURE__*/React.createElement("p", {
        className: "knowledge-owner"
      }, p.author, p.dept ? ` · ${p.dept}` : ''), /*#__PURE__*/React.createElement("p", {
        className: "knowledge-purpose"
      }, summaryOf(p)), /*#__PURE__*/React.createElement("div", {
        className: "knowledge-meta"
      }, /*#__PURE__*/React.createElement("span", {
        className: `tag-status-${projectStage(p)}`
      }, projectStage(p)), tools.map(t => /*#__PURE__*/React.createElement("span", {
        key: t
      }, t)))), /*#__PURE__*/React.createElement("div", {
        className: "knowledge-insight"
      }, /*#__PURE__*/React.createElement("div", {
        className: `knowledge-insight-grid ${highlights.length ? '' : 'knowledge-insight-grid-full'}`
      }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
        className: "knowledge-label"
      }, catalogMode === '找工具' ? '◎ 適合解決' : '◎ 可複用做法'), /*#__PURE__*/React.createElement("p", {
        className: "knowledge-method"
      }, catalogCopyOf(p, catalogMode))), highlights.length > 0 && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
        className: "knowledge-label"
      }, "✦ 做法亮點", /*#__PURE__*/React.createElement("span", {
        className: "auto-summary-tag",
        title: "由用途、優化方法與目前進度自動整理"
      }, "自動整理")), /*#__PURE__*/React.createElement("ul", {
        className: "knowledge-highlights"
      }, highlights.map(point => /*#__PURE__*/React.createElement("li", {
        key: point
      }, point))))), /*#__PURE__*/React.createElement("div", {
        className: "knowledge-actions"
      }, /*#__PURE__*/React.createElement("span", {
        className: "knowledge-complete"
      }, catalogCompletenessOf(p)), /*#__PURE__*/React.createElement("div", {
        className: "row-actions"
      }, /*#__PURE__*/React.createElement("button", {
        className: "btn-ghost px-3 py-2 rounded-lg text-sm",
        onClick: () => openProjectDetail(p)
      }, catalogMode === '學做法' ? '完整做法' : '查看詳情'), safeLink(p.link) && /*#__PURE__*/React.createElement("a", {
        className: "btn-accent px-3 py-2 rounded-lg text-sm font-bold",
        href: safeLink(p.link),
        target: "_blank",
        rel: "noopener noreferrer"
      }, "開啟工具 ↗")))))];
    })));
  })(), currentTab === "單位成員" && /*#__PURE__*/React.createElement("div", {
    className: "p-6 max-w-7xl mx-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "page-eyebrow mb-1"
  }, "DASHBOARD"), /*#__PURE__*/React.createElement("h1", {
    className: "page-title mb-1"
  }, "單位成員", /*#__PURE__*/React.createElement("span", {
    className: "accent"
  }, ".")), /*#__PURE__*/React.createElement("p", {
    className: "page-sub"
  }, "依上線數排序，含共同協作成果；數量不代表改善效益。")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 mb-5 flex-wrap"
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-sm t2"
  }, "成果期間 ", /*#__PURE__*/React.createElement("select", {
    "aria-label": "成員成果期間",
    className: "app-input rounded-lg p-2 ml-2",
    value: memberPeriod,
    onChange: e => setMemberPeriod(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "全部時間"), /*#__PURE__*/React.createElement("option", {
    value: "30"
  }, "近 30 天啟動"), /*#__PURE__*/React.createElement("option", {
    value: "90"
  }, "近 90 天啟動"), /*#__PURE__*/React.createElement("option", {
    value: "365"
  }, "近一年啟動"))), /*#__PURE__*/React.createElement("span", {
    className: "text-xs t3 mr-1"
  }, "班別"), ["全部", ...UNIT_OPTIONS].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    onClick: () => setMemberShift(s),
    className: `px-4 py-1.5 rounded-full text-sm font-bold transition-all ${memberShift === s ? 'btn-accent' : 'btn-ghost'}`
  }, s))), Object.keys(unitGroups).filter(unit => memberShift === "全部" || unit === memberShift).sort((a, b) => {
    const shiftOrder = {
      "早": 0,
      "中": 1,
      "晚": 2
    };
    const getShiftChar = unit => unit.split("-")[1] || unit;
    return (shiftOrder[getShiftChar(a)] ?? 3) - (shiftOrder[getShiftChar(b)] ?? 3);
  }).map(unit => {
    const members = unitGroups[unit];
    const unitCounts = {};
    const uniqueProjects = [...new Map(members.flatMap(m => m.projects).map(p => [p.id, p])).values()];
    STATUS_LIST.forEach(s => unitCounts[s] = uniqueProjects.filter(p => projectStage(p) === s).length);
    return /*#__PURE__*/React.createElement("div", {
      key: unit,
      className: "mb-8"
    }, /*#__PURE__*/React.createElement("div", {
      className: "app-card rounded-xl p-5 mb-4 flex flex-wrap items-center justify-between gap-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-4"
    }, /*#__PURE__*/React.createElement("span", {
      className: "text-3xl font-black t1"
    }, unit), /*#__PURE__*/React.createElement("span", {
      className: "text-sm t3 font-semibold"
    }, "成員成果・專案去重統計・", members.length, " 位")), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2 text-sm t2 flex-wrap"
    }, STATUS_LIST.map(s => /*#__PURE__*/React.createElement("span", {
      key: s,
      className: `px-3 py-1 rounded-full font-semibold tag-status-${s}`
    }, s, " ", unitCounts[s])))), /*#__PURE__*/React.createElement("div", {
      className: "member-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
    }, members.map(m => /*#__PURE__*/React.createElement("div", {
      key: m.user.id,
      className: "app-card rounded-xl p-4 flex flex-col"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-start justify-between pb-3 border-b bd"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2.5"
    }, getShift(m.user) && /*#__PURE__*/React.createElement("span", {
      className: "w-10 h-10 rounded-lg app-panel flex items-center justify-center text-sm font-bold accent"
    }, getShift(m.user)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "font-black text-lg t1 flex items-center gap-1.5"
    }, m.user.name), /*#__PURE__*/React.createElement("div", {
      className: "text-xs t3 mt-0.5"
    }, STATUS_LIST.filter(s => m.counts[s] > 0).map(s => `${s} ${m.counts[s]}`).join('・') || "尚無成果"))), /*#__PURE__*/React.createElement("div", {
      className: "text-right shrink-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-3xl font-black accent leading-none"
    }, m.counts["上線"]), /*#__PURE__*/React.createElement("div", {
      className: "text-xs t3 mt-1"
    }, "已上線 / 共 ", m.total, " 項"))), m.projects.length === 0 ? /*#__PURE__*/React.createElement("p", {
      className: "text-xs t3 py-4 text-center"
    }, "尚無發布專案") : /*#__PURE__*/React.createElement("ul", {
      className: "divide-y divide-[var(--border)]"
    }, (expandedMembers.includes(m.user.id) ? m.projects : m.projects.slice(0, 4)).map(p => /*#__PURE__*/React.createElement("li", {
      key: p.id,
      onClick: () => openProjectDetail(p),
      className: "py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:opacity-75 px-2 -mx-2 rounded transition-opacity"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2 min-w-0"
    }, /*#__PURE__*/React.createElement("span", {
      className: `text-[11px] shrink-0 px-2 py-0.5 rounded font-semibold tag-type-${p.type === '專案' ? '專案' : '工具'}`
    }, p.type === '專案' ? '專案' : '工具'), p.author !== m.user.name && /*#__PURE__*/React.createElement("span", {
      className: "text-[11px] shrink-0 px-2 py-0.5 rounded btn-accent-soft font-semibold"
    }, "協作"), /*#__PURE__*/React.createElement("span", {
      className: "text-sm t1 font-semibold truncate"
    }, p.title)), /*#__PURE__*/React.createElement("span", {
      className: `shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold tag-status-${projectStage(p)}`
    }, projectStage(p))))), m.projects.length > 4 && /*#__PURE__*/React.createElement("button", {
      "aria-expanded": expandedMembers.includes(m.user.id),
      className: "btn-ghost text-sm rounded-lg px-3 py-2 mt-3",
      onClick: () => setExpandedMembers(prev => prev.includes(m.user.id) ? prev.filter(id => id !== m.user.id) : [...prev, m.user.id])
    }, expandedMembers.includes(m.user.id) ? '收合成果' : `查看全部 ${m.total} 項`)))));
  })), currentTab === "帳號管理" && canAccessAccounts(currentUser) && /*#__PURE__*/React.createElement("div", {
    className: "p-6 max-w-7xl mx-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-6"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "page-eyebrow mb-1"
  }, "DASHBOARD"), /*#__PURE__*/React.createElement("h1", {
    className: "page-title mb-1"
  }, "帳號管理", /*#__PURE__*/React.createElement("span", {
    className: "accent"
  }, ".")), /*#__PURE__*/React.createElement("p", {
    className: "page-sub"
  }, "管理成員權限、密碼與帳號啟用狀態", currentUser.role === "ADMIN" ? "（管理員可管理一般成員）" : "（主管可管理所有人）")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowUserModal(true),
    className: "px-4 py-2 btn-accent-soft rounded-lg text-sm font-bold flex items-center gap-2"
  }, "👤+ 新增成員帳號")), /*#__PURE__*/React.createElement("select", {
    value: groupBy,
    onChange: e => setGroupBy(e.target.value),
    className: "app-input text-xs px-3 py-2 rounded-lg font-semibold ml-2"
  }, /*#__PURE__*/React.createElement("option", {
    value: "role"
  }, "依角色分組"), /*#__PURE__*/React.createElement("option", {
    value: "shift"
  }, "依班別分組")), /*#__PURE__*/React.createElement("div", {
    className: "app-card rounded-xl p-4 overflow-x-auto"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-left text-sm t2"
  }, /*#__PURE__*/React.createElement("thead", {
    className: "border-b bd t3"
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    className: "p-3"
  }, "暱稱"), /*#__PURE__*/React.createElement("th", {
    className: "p-3"
  }, "帳號"), /*#__PURE__*/React.createElement("th", {
    className: "p-3"
  }, "單位"), /*#__PURE__*/React.createElement("th", {
    className: "p-3"
  }, "權限"), /*#__PURE__*/React.createElement("th", {
    className: "p-3"
  }, "狀態"), /*#__PURE__*/React.createElement("th", {
    className: "p-3 text-right"
  }, "操作"))), /*#__PURE__*/React.createElement("tbody", null, groupedUsers.map(group => /*#__PURE__*/React.createElement(React.Fragment, {
    key: group.key
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 6,
    className: "p-2 bg-white/5 text-xs font-bold t2"
  }, group.label, " ", /*#__PURE__*/React.createElement("span", {
    className: "t3 font-normal"
  }, "(", group.members.length, ")"))), group.members.map(u => {
    const disabled = u.status === 'disabled';
    const isSelf = u.account === currentUser.account;
    const manageable = canManageAccount(currentUser, u);
    const roleCls = u.role === "BOSS" ? "tag-type-專案" : u.role === "ADMIN" ? "btn-accent-soft" : "btn-ghost";
    return /*#__PURE__*/React.createElement("tr", {
      key: u.id,
      className: `border-b bd ${disabled ? 'opacity-50' : ''}`
    }, /*#__PURE__*/React.createElement("td", {
      className: "p-3 font-semibold t1"
    }, u.name, isSelf && /*#__PURE__*/React.createElement("span", {
      className: "text-[10px] t3 ml-1"
    }, "(自己)")), /*#__PURE__*/React.createElement("td", {
      className: "p-3"
    }, u.account), /*#__PURE__*/React.createElement("td", {
      className: "p-3"
    }, u.unit || 'JJ'), /*#__PURE__*/React.createElement("td", {
      className: "p-3"
    }, /*#__PURE__*/React.createElement("span", {
      className: `text-xs px-2 py-0.5 rounded font-semibold ${roleCls}`
    }, roleLabel(u.role))), /*#__PURE__*/React.createElement("td", {
      className: "p-3"
    }, disabled ? /*#__PURE__*/React.createElement("span", {
      className: "text-xs btn-danger px-2 py-0.5 rounded"
    }, "已停用") : /*#__PURE__*/React.createElement("span", {
      className: "text-xs tag-status-上線 px-2 py-0.5 rounded"
    }, "啟用中")), /*#__PURE__*/React.createElement("td", {
      className: "p-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex items-center justify-end gap-2"
    }, manageable ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      onClick: () => handleOpenEditUser(u),
      className: "text-xs btn-ghost px-2.5 py-1 rounded-md"
    }, "✏️ 編輯"), !isSelf && /*#__PURE__*/React.createElement("button", {
      onClick: () => handleToggleUserStatus(u),
      className: `text-xs px-2.5 py-1 rounded-md ${disabled ? 'btn-accent-soft' : 'btn-danger'}`
    }, disabled ? '✅ 啟用' : '🚫 停用')) : /*#__PURE__*/React.createElement("span", {
      className: "text-[11px] t3"
    }, "—"))));
  }))))))), pwPrompt && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[65]"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card p-6 rounded-2xl w-full max-w-sm"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-bold t1 mb-1"
  }, "🔒 此專案受密碼保護"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs t3 mb-4"
  }, "「", pwPrompt.project.title, "」需輸入查看密碼"), /*#__PURE__*/React.createElement("form", {
    onSubmit: submitViewPassword,
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("input", {
    type: "password",
    autoFocus: true,
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: pwInput,
    onChange: e => {
      setPwInput(e.target.value);
      setPwError("");
    },
    placeholder: "請輸入查看密碼"
  }), pwError && /*#__PURE__*/React.createElement("p", {
    className: "text-xs danger"
  }, pwError), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2 pt-1"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setPwPrompt(null);
      setPwInput("");
      setPwError("");
    },
    className: "px-4 py-2 t3 text-sm hover:opacity-70"
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    className: "px-5 py-2 btn-accent font-bold text-sm rounded-lg"
  }, "確認查看"))))), showMyPwModal && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-[65]"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card p-6 rounded-2xl w-full max-w-sm"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-bold t1 mb-1"
  }, "🔑 修改我的密碼"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs t3 mb-4"
  }, "帳號：", currentUser.account), /*#__PURE__*/React.createElement("form", {
    onSubmit: handleChangeMyPassword,
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "目前密碼"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    maxLength: "6",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: myPwForm.oldPw,
    onChange: e => {
      setMyPwForm({
        ...myPwForm,
        oldPw: e.target.value.replace(/\D/g, '').slice(0, 6)
      });
      setMyPwError("");
    },
    placeholder: "輸入目前的密碼"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "新密碼（6 位數字）"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    maxLength: "6",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: myPwForm.newPw,
    onChange: e => {
      setMyPwForm({
        ...myPwForm,
        newPw: e.target.value.replace(/\D/g, '').slice(0, 6)
      });
      setMyPwError("");
    },
    placeholder: "例如：135790"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "再次輸入新密碼"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    maxLength: "6",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: myPwForm.confirmPw,
    onChange: e => {
      setMyPwForm({
        ...myPwForm,
        confirmPw: e.target.value.replace(/\D/g, '').slice(0, 6)
      });
      setMyPwError("");
    },
    placeholder: "再輸入一次新密碼"
  })), myPwError && /*#__PURE__*/React.createElement("p", {
    className: "text-xs danger"
  }, myPwError), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2 pt-1"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setShowMyPwModal(false),
    className: "px-4 py-2 t3 text-sm hover:opacity-70"
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    disabled: myPwSaving,
    className: "px-5 py-2 btn-accent font-bold text-sm rounded-lg disabled:opacity-50"
  }, myPwSaving ? '儲存中...' : '更新密碼'))))), lightboxUrl && React.createElement("div", {
    className: "image-viewer", role: "dialog", "aria-modal": true, "aria-label": "成果圖片預覽",
    onKeyDown: e => {
      if (e.key === 'Tab') {
        const buttons = [...e.currentTarget.querySelectorAll('button:not(:disabled)')];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
  }, React.createElement("div", {className: "image-viewer-toolbar"},
    React.createElement("button", {disabled: lightboxZoom <= 1, onClick: () => setLightboxZoom(z => Math.max(1, z - .5)), "aria-label": "縮小圖片"}, "− 縮小"),
    React.createElement("span", {"aria-live": "polite"}, Math.round(lightboxZoom * 100) + "%"),
    React.createElement("button", {disabled: lightboxZoom >= 4, onClick: () => setLightboxZoom(z => Math.min(4, z + .5)), "aria-label": "放大圖片"}, "🔍＋ 放大"),
    React.createElement("button", {onClick: () => setLightboxZoom(1)}, "重設"),
    React.createElement("button", {ref: lightboxCloseRef, onClick: () => setLightboxUrl(null), "aria-label": "關閉圖片預覽", title: "關閉 (Esc)"}, "✕ 關閉")
  ), React.createElement("div", {
    className: "image-viewer-scroll",
    onClick: e => { if(e.target === e.currentTarget) setLightboxUrl(null); }
  }, React.createElement("img", {
    src: lightboxUrl, alt: "成果展示圖片",
    onLoad: e => { const r = e.currentTarget.getBoundingClientRect(); setLightboxSize({width:r.width,height:r.height}); },
    style: lightboxSize ? {width: lightboxSize.width * lightboxZoom, height: lightboxSize.height * lightboxZoom, maxWidth:'none', maxHeight:'none'} : undefined
  })), React.createElement("p", {className:"image-viewer-hint"}, "放大後可上下、左右捲動查看細節 · Esc 關閉")), editUserTarget && canAccessAccounts(currentUser) && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 bg-black/60 flex items-start justify-center p-4 z-50 overflow-y-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card p-6 rounded-2xl w-full max-w-md my-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between mb-4"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-xl font-bold t1"
  }, "✏️ 編輯帳號"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditUserTarget(null),
    className: "t3 hover:opacity-70 text-xl leading-none"
  }, "✕")), /*#__PURE__*/React.createElement("p", {
    className: "text-xs t3 mb-4"
  }, "帳號：", editUserTarget.account), /*#__PURE__*/React.createElement("form", {
    onSubmit: handleSaveEditUser,
    className: "space-y-4"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "暱稱（畫面顯示為負責人）"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    required: true,
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: editUserForm.name,
    onChange: e => setEditUserForm({
      ...editUserForm,
      name: e.target.value
    })
  }), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "修改暱稱會同步更新其名下所有專案的負責人名稱")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "權限"), isBoss(currentUser) ? /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-3 gap-0 rounded-lg overflow-hidden border bd"
  }, [["MEMBER", "MEMBER"], ["ADMIN", "ADMIN"], ["BOSS", "BOSS"]].map(([val, label]) => /*#__PURE__*/React.createElement("button", {
    key: val,
    type: "button",
    onClick: () => setEditUserForm({
      ...editUserForm,
      role: val
    }),
    className: `py-2 text-sm font-semibold transition-colors ${editUserForm.role === val ? 'btn-accent' : 'btn-ghost border-0 rounded-none'}`
  }, label))) : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-0 rounded-lg overflow-hidden border bd"
  }, [["MEMBER", "MEMBER"], ["ADMIN", "ADMIN"]].map(([val, label]) => /*#__PURE__*/React.createElement("button", {
    key: val,
    type: "button",
    onClick: () => setEditUserForm({
      ...editUserForm,
      role: val
    }),
    className: `py-2 text-sm font-semibold transition-colors ${editUserForm.role === val ? 'btn-accent' : 'btn-ghost border-0 rounded-none'}`
  }, label))), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "只有 BOSS 能指派 BOSS 權限"))), editUserForm.role !== "BOSS" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "所屬單位（含班別）"), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2"
  }, UNIT_OPTIONS.map(opt => /*#__PURE__*/React.createElement("button", {
    key: opt,
    type: "button",
    onClick: () => setEditUserForm({
      ...editUserForm,
      unit: opt
    }),
    className: `px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${editUserForm.unit === opt ? 'btn-accent' : 'btn-ghost'}`
  }, opt)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "重設密碼（留空＝不改）"), /*#__PURE__*/React.createElement("input", {
    type: "password",
    inputMode: "numeric",
    maxLength: "6",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: editUserForm.password,
    onChange: e => setEditUserForm({
      ...editUserForm,
      password: e.target.value.replace(/\D/g, '').slice(0, 6)
    }),
    placeholder: "留空則不變更"
  }), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "需為 6 位數字，例如 123456")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-2 pt-2"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setEditUserTarget(null),
    className: "py-2.5 rounded-lg text-sm font-semibold btn-ghost"
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    disabled: editUserSaving,
    className: "py-2.5 rounded-lg text-sm font-bold btn-accent disabled:opacity-50"
  }, editUserSaving ? '儲存中...' : '儲存')), editUserTarget.account !== currentUser.account && /*#__PURE__*/React.createElement("div", {
    className: "pt-1"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleDeleteUser(editUserTarget),
    className: "w-full py-2.5 rounded-lg text-sm font-bold btn-danger"
  }, "刪除此帳號"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 text-center mt-2"
  }, "帳號若仍是某專案的負責人則無法刪除"))))), showProjectModal && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 bg-black/60 flex items-start justify-center p-4 z-50 overflow-y-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card p-6 rounded-2xl w-full max-w-lg my-8"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-xl font-bold mb-4 t1"
  }, editingProjectId ? "✏️ 編輯專案" : "發布 AI 專案"), /*#__PURE__*/React.createElement("form", {
    onSubmit: handleAddProject,
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "專案名稱"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    required: true,
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.title,
    onChange: e => setNewProject({
      ...newProject,
      title: e.target.value
    }),
    placeholder: "例如：客服文字自動發信工具"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "用途分類"), /*#__PURE__*/React.createElement("select", {
    "aria-label": "用途分類",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.category || '',
    onChange: e => setNewProject({
      ...newProject,
      category: e.target.value
    })
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "尚未分類"), CATEGORY_LIST.map(v => /*#__PURE__*/React.createElement("option", {
    key: v
  }, v)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-sm t1 font-bold block"
  }, "專案類型"), /*#__PURE__*/React.createElement("p", {
    className: "project-type-help"
  }, "先決定這是大型專案，還是單一功能的小工具。"), /*#__PURE__*/React.createElement("div", {
    className: "project-type-grid"
  }, [["專案", "較大型，可包含多個畫面"], ["小工具", "單一功能的小工具"]].map(([type, description]) => /*#__PURE__*/React.createElement("button", {
    key: type,
    type: "button",
    onClick: () => setNewProject({
      ...newProject,
      type
    }),
    className: "project-type-choice",
    "aria-pressed": newProject.type === type
  }, /*#__PURE__*/React.createElement("span", {
    className: "project-type-copy"
  }, /*#__PURE__*/React.createElement("strong", null, type), /*#__PURE__*/React.createElement("span", null, description)), /*#__PURE__*/React.createElement("span", {
    className: "project-type-dot",
    "aria-hidden": "true"
  }))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "開發進度"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-1.5"
  }, STATUS_LIST.map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    type: "button",
    onClick: () => setNewProject({
      ...newProject,
      status: s
    }),
    className: `px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all ${newProject.status === s ? 'btn-accent' : `tag-status-${s} opacity-60 hover:opacity-100`}`
  }, s)))), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "單位"), /*#__PURE__*/React.createElement("select", {
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.dept,
    onChange: e => {
      const nextDept = e.target.value;
      const eligible = membersInUnit(nextDept);
      const currentAuthor = newProject.author || currentUser.name;
      const nextAuthor = editingProjectId || eligible.some(user => user.name === currentAuthor) ? currentAuthor : eligible[0]?.name || '';
      setNewProject({
        ...newProject,
        dept: nextDept,
        author: nextAuthor
      });
    }
  }, !UNIT_OPTIONS.includes(newProject.dept) && newProject.dept ? /*#__PURE__*/React.createElement("option", {
    value: newProject.dept
  }, newProject.dept) : null, UNIT_OPTIONS.map(opt => /*#__PURE__*/React.createElement("option", {
    key: opt,
    value: opt
  }, opt)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "發布者 / 負責人"), /*#__PURE__*/React.createElement("select", {
    disabled: !!editingProjectId,
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.author || (membersInUnit(newProject.dept).some(user => user.name === currentUser.name) ? currentUser.name : ''),
    onChange: e => {
      const name = e.target.value;
      setNewProject(prev => ({
        ...prev,
        author: name,
        dept: unitOfMember(name),
        collaborators: prev.collaborators.filter(n => n !== name)
      }));
    }
  }, membersInUnit(newProject.dept).length === 0 && /*#__PURE__*/React.createElement("option", {
    value: "",
    disabled: true
  }, "此班別尚無成員"), users.filter(user => unitOfUser(user) === newProject.dept || editingProjectId && user.name === newProject.author).map(user => /*#__PURE__*/React.createElement("option", {
    key: user.id,
    value: user.name
  }, user.name))), editingProjectId && /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "編輯時發布者不可更改"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "🤝 共同研究成員（下拉新增，點 ✕ 移除；協作者也能編輯此專案）"), /*#__PURE__*/React.createElement("select", {
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: "",
    onChange: e => {
      const name = e.target.value;
      if (!name) return;
      setNewProject(prev => prev.collaborators.includes(name) ? prev : {
        ...prev,
        collaborators: [...prev.collaborators, name]
      });
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "＋ 選擇要加入的成員..."), users.filter(u => u.name !== (newProject.author || currentUser.name) && !newProject.collaborators.includes(u.name)).map(u => /*#__PURE__*/React.createElement("option", {
    key: u.id,
    value: u.name
  }, u.name, "（", u.unit || 'JJ', "）"))), newProject.collaborators.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "mt-2 flex flex-wrap gap-1.5"
  }, newProject.collaborators.map(name => /*#__PURE__*/React.createElement("span", {
    key: name,
    className: "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold btn-accent-soft"
  }, name, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setNewProject(prev => ({
      ...prev,
      collaborators: prev.collaborators.filter(n => n !== name)
    })),
    className: "hover:opacity-60",
    title: "移除"
  }, "✕"))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "🤖 使用的 AI 工具（以逗號分隔）"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.ai_tools,
    onChange: e => setNewProject({
      ...newProject,
      ai_tools: e.target.value
    }),
    placeholder: "例如：Claude, ChatGPT, Gemini"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs sec-pain block mb-1"
  }, "🚨 痛點描述 (目前現況與問題點)"), /*#__PURE__*/React.createElement("textarea", {
    rows: "2",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.pain_point,
    onChange: e => setNewProject({
      ...newProject,
      pain_point: e.target.value
    }),
    placeholder: "例如：聽錄音檔太煩..."
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs sec-target block mb-1"
  }, "🎯 預期目標"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.target,
    onChange: e => setNewProject({
      ...newProject,
      target: e.target.value
    }),
    placeholder: "例如：快速知道錄音內容"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs sec-solution block mb-1"
  }, "⚡ 優化方法"), /*#__PURE__*/React.createElement("textarea", {
    rows: "2",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.solution,
    onChange: e => setNewProject({
      ...newProject,
      solution: e.target.value
    }),
    placeholder: "例如：利用該網址轉化文字..."
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs sec-progress block mb-1"
  }, "📈 目前進展（每筆進度請按 Enter 換行，會自動分列顯示）"), /*#__PURE__*/React.createElement("textarea", {
    rows: "4",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.progress,
    onChange: e => setNewProject({
      ...newProject,
      progress: e.target.value
    }),
    placeholder: "例如（每行一筆）：\n8/16 完成支付寶一般轉帳驗證\n8/17 支付寶一般轉帳對應帳戶\n8/19 將整個回單憑證 AI 工具轉移到正式站"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "專案網址 (URL)"), /*#__PURE__*/React.createElement("input", {
    type: "url",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.link,
    onChange: e => setNewProject({
      ...newProject,
      link: e.target.value
    }),
    placeholder: "https://"
  })), /*#__PURE__*/React.createElement("div", {
    className: "app-panel rounded-lg p-3"
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t2 font-bold block mb-1"
  }, "🔒 查看密碼（選填，隱私專案專用）"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newProject.view_password,
    onChange: e => setNewProject({
      ...newProject,
      view_password: e.target.value
    }),
    placeholder: "留空＝公開；填寫後他人需輸入此密碼才能查看"
  }), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "設定後，除了你本人與共同研究成員外，其他人（含 BOSS／ADMIN）點進此專案都需先輸入這組密碼。")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "📷 成果附圖（最多 ", MAX_IMAGES, " 張，可一次多選，點 ✕ 可刪除）"), /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    onChange: handleImageUpload,
    disabled: newProject.images.length >= MAX_IMAGES,
    className: "w-full p-2 rounded-lg app-input app-file text-xs"
  }), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "已上傳 ", newProject.images.length, " / ", MAX_IMAGES, " 張"), newProject.images.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "mt-2 flex flex-wrap gap-2"
  }, newProject.images.map((img, idx) => /*#__PURE__*/React.createElement("div", {
    key: idx,
    className: "relative"
  }, /*#__PURE__*/React.createElement("img", {
    src: img,
    alt: `預覽 ${idx + 1}`,
    className: "h-24 w-24 rounded border bd object-cover"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleRemoveImage(idx),
    title: "刪除這張圖",
    className: "absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-500 hover:bg-red-400 text-white text-xs font-bold flex items-center justify-center shadow-lg"
  }, "✕"))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "📎 相關文件（txt / pdf / office / html 等，最多 ", MAX_FILES, " 個，每個 ≤ ", MAX_FILE_MB, "MB）"), /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: ".txt,.md,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.html,.htm,.json,.zip",
    multiple: true,
    onChange: handleDocUpload,
    disabled: uploadingFiles || newProject.files.length >= MAX_FILES,
    className: "w-full p-2 rounded-lg app-input app-file text-xs"
  }), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, uploadingFiles ? '⏳ 文件上傳中...' : `已上傳 ${newProject.files.length} / ${MAX_FILES} 個`), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "⚠️ 文字類檔案（txt / md / csv / html 等）請先存成 UTF-8 編碼再上傳，否則線上開啟會顯示亂碼（記事本「另存新檔」→ 編碼選 UTF-8；html 也可在檔案開頭加一行 <meta charset=\"utf-8\">）"), newProject.files.length > 0 && /*#__PURE__*/React.createElement("ul", {
    className: "mt-2 space-y-1.5"
  }, newProject.files.map((f, idx) => /*#__PURE__*/React.createElement("li", {
    key: idx,
    className: "flex items-center justify-between gap-2 app-panel rounded-lg px-3 py-1.5"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-xs t1 truncate"
  }, "📄 ", f.name), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleRemoveFile(idx),
    className: "text-xs danger hover:opacity-70 shrink-0"
  }, "✕ 刪除"))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "🎬 操作教學影片（1 部，≤ ", MAX_VIDEO_MB, "MB，mp4 / webm）"), newProject.video ? /*#__PURE__*/React.createElement("div", {
    className: "space-y-2"
  }, /*#__PURE__*/React.createElement("video", {
    src: newProject.video,
    controls: true,
    className: "w-full max-h-48 rounded-lg border bd bg-black"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handleRemoveVideo,
    className: "text-xs btn-danger px-2.5 py-1 rounded-md"
  }, "✕ 移除影片")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "video/*",
    onChange: handleVideoUpload,
    disabled: uploadingVideo,
    className: "w-full p-2 rounded-lg app-input app-file text-xs"
  }), uploadingVideo && /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "⏳ 影片上傳中，請稍候（依檔案大小可能需要一點時間）..."))), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2 pt-3"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handleCloseProjectModal,
    className: "px-4 py-2 t3 text-sm hover:opacity-70"
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    disabled: submitting || uploadingFiles || uploadingVideo,
    className: "px-5 py-2 btn-accent font-bold text-sm rounded-lg disabled:opacity-50"
  }, submitting ? editingProjectId ? '更新中...' : '發布中...' : editingProjectId ? '儲存變更' : '確認發布'))))), showUserModal && canAccessAccounts(currentUser) && /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-card p-6 rounded-2xl w-full max-w-md"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-xl font-bold mb-4 t1"
  }, "👤 新增成員帳號"), /*#__PURE__*/React.createElement("form", {
    onSubmit: handleAddUser,
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "成員暱稱"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    required: true,
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newUser.name,
    onChange: e => setNewUser({
      ...newUser,
      name: e.target.value
    }),
    placeholder: "例如：成員 B"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "帳號（英文＋數字組合）"), /*#__PURE__*/React.createElement("input", {
    type: "text",
    required: true,
    pattern: "^(?=.*[A-Za-z])(?=.*\\d)[A-Za-z0-9]+$",
    title: "帳號需同時包含英文字母與數字",
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newUser.account,
    onChange: e => setNewUser({
      ...newUser,
      account: e.target.value
    }),
    placeholder: "例如：user01"
  }), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "需同時包含英文字母與數字，例如 user01")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "預設密碼"), /*#__PURE__*/React.createElement("div", {
    className: "py-2.5 px-3 rounded-lg app-panel text-sm t2"
  }, "123456（系統預設）"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] t3 mt-1"
  }, "新帳號一律使用預設密碼 123456，請提醒對方登入後點右上角自己的名字自行修改。")), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "單位（含班別）"), newUser.role === "BOSS" ? /*#__PURE__*/React.createElement("div", {
    className: "py-2.5 px-3 rounded-lg app-panel text-sm t3"
  }, "BOSS 不分班別") : /*#__PURE__*/React.createElement("select", {
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newUser.unit,
    onChange: e => setNewUser({
      ...newUser,
      unit: e.target.value
    })
  }, UNIT_OPTIONS.map(opt => /*#__PURE__*/React.createElement("option", {
    key: opt,
    value: opt
  }, opt)))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-xs t3 block mb-1"
  }, "權限角色"), /*#__PURE__*/React.createElement("select", {
    className: "w-full p-2.5 rounded-lg app-input text-sm",
    value: newUser.role,
    onChange: e => setNewUser({
      ...newUser,
      role: e.target.value
    })
  }, /*#__PURE__*/React.createElement("option", {
    value: "MEMBER"
  }, "MEMBER"), /*#__PURE__*/React.createElement("option", {
    value: "ADMIN"
  }, "ADMIN"), /*#__PURE__*/React.createElement("option", {
    value: "BOSS"
  }, "BOSS")))), /*#__PURE__*/React.createElement("div", {
    className: "flex justify-end gap-2 pt-3"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setShowUserModal(false),
    className: "px-4 py-2 t3 text-sm hover:opacity-70"
  }, "取消"), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    className: "px-5 py-2 btn-accent font-bold text-sm rounded-lg"
  }, "確認新增"))))));
}
class BoardErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={failed:false};}
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(error){window.boardBootError(error);}
  render(){return this.state.failed ? React.createElement('div',{style:{padding:'24px'}},'畫面載入失敗，請查看上方錯誤提示。') : this.props.children;}
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(BoardErrorBoundary, null, React.createElement(App, null)));
    
})();
