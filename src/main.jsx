import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isSupabaseConfigured, supabase } from "./supabaseClient";
import "./styles.css";

const markdownFiles = import.meta.glob("../*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const STORAGE_KEY = "art-recite-react-v2";
const SETTINGS_KEY = "art-recite-settings-v2";
const PERMANENT_SAVE_URL = `${import.meta.env.BASE_URL}saved-content.json`;

function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value = "") {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function insertPlainTextAtCursor(text) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  selection.deleteFromDocument();
  const range = selection.getRangeAt(0);
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function handlePlainTextPaste(event) {
  const text = event.clipboardData?.getData("text/plain");
  if (text == null) return;
  event.preventDefault();

  if (!document.execCommand?.("insertText", false, text)) {
    insertPlainTextAtCursor(text);
  }
}

function formatAnswer(lines) {
  const paragraphs = lines.join("\n").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return paragraphs.map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br />")}</p>`).join("");
}

function chapterTitleFromFile(fileName) {
  return fileName.replace(/\.md$/i, "").replace(/-/g, "：");
}

function chapterOrder(filePath) {
  const fileName = filePath.split("/").pop() ?? filePath;
  const numberText = fileName.match(/^第([一二三四五六七八九十百千万零\d]+)章/)?.[1];
  if (!numberText) return Number.MAX_SAFE_INTEGER;
  if (/^\d+$/.test(numberText)) return Number(numberText);
  const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (numberText === "十") return 10;
  if (numberText.includes("十")) {
    const [tens, ones] = numberText.split("十");
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return digits[numberText] ?? Number.MAX_SAFE_INTEGER;
}

function parseMarkdown(markdown, fileName) {
  const chapter = {
    id: uid("chapter"),
    title: chapterTitleFromFile(fileName),
    source: fileName,
    sections: [],
  };
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let section = null;
  let item = null;

  const ensureSection = () => {
    if (!section) {
      section = { id: uid("section"), title: "知识点", items: [] };
      chapter.sections.push(section);
    }
    return section;
  };

  const closeItem = () => {
    if (!section || !item) return;
    item.answerHtml = formatAnswer(item.answerLines);
    delete item.answerLines;
    section.items.push(item);
    item = null;
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trimEnd();
    if (/^>\s*$/.test(line)) return;
    const heading = line.match(/^#\s+(.+)/);
    const prompt = line.match(/^>\s*\*+/);

    if (heading) {
      closeItem();
      section = { id: uid("section"), title: heading[1].trim(), items: [] };
      chapter.sections.push(section);
      return;
    }

    if (prompt) {
      closeItem();
      ensureSection();
      item = {
        id: uid("item"),
        question: line.replace(/^>\s*/, "").replace(/^\*+/, "").replace(/\*+$/, "").trim(),
        answerLines: [],
        maskedQuestion: false,
        maskedAnswer: false,
      };
      return;
    }

    if (item) item.answerLines.push(line);
  });

  closeItem();
  if (chapter.sections.length === 0) {
    chapter.sections.push({ id: uid("section"), title: "知识点", items: [] });
  }
  return chapter;
}

function getInitialContent() {
  return Object.entries(markdownFiles)
    .sort(([a], [b]) => chapterOrder(a) - chapterOrder(b) || a.localeCompare(b, "zh-CN"))
    .map(([path, markdown]) => parseMarkdown(markdown, path.split("/").pop()));
}

function readStoredContent() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : getInitialContent();
  } catch {
    return getInitialContent();
  }
}

function readStoredSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

async function readPermanentSave() {
  const response = await fetch(`${PERMANENT_SAVE_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) return null;
  const payload = await response.json();
  if (!Array.isArray(payload.chapters) || !payload.settings) return null;
  return payload;
}

async function readCloudContent() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("recitation_content")
    .select("data")
    .eq("id", "main")
    .maybeSingle();

  if (error) throw error;
  const payload = data?.data;
  if (!payload || !Array.isArray(payload.chapters) || !payload.settings) return null;
  return payload;
}

async function saveCloudContent(payload) {
  if (!supabase) throw new Error("Supabase is not configured");
  const { error } = await supabase
    .from("recitation_content")
    .update({
      data: payload,
      updated_at: new Date().toISOString(),
    })
    .eq("id", "main")
    .select("id")
    .single();

  if (error) throw error;
}

async function checkEditorPermission(email) {
  if (!supabase || !email) return false;
  const { data, error } = await supabase
    .from("allowed_editors")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (error) return false;
  return Boolean(data);
}

function Editable({ className = "", html, onCommit, readOnly = false, tagName: Tag = "div", ...props }) {
  const ref = useRef(null);
  const lastHtml = useRef(html);

  useEffect(() => {
    if (ref.current && lastHtml.current !== html && document.activeElement !== ref.current) {
      ref.current.innerHTML = html;
      lastHtml.current = html;
    }
  }, [html]);

  return (
    <Tag
      ref={ref}
      className={className}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      dangerouslySetInnerHTML={{ __html: html }}
      onPaste={handlePlainTextPaste}
      onBlur={() => {
        if (readOnly) return;
        const next = ref.current?.innerHTML ?? "";
        lastHtml.current = next;
        onCommit(next);
      }}
      {...props}
    />
  );
}

function EditableText({ className = "", value, placeholder, onCommit, readOnly = false, tagName: Tag = "div", ...props }) {
  const ref = useRef(null);
  const lastValue = useRef(value ?? "");

  useEffect(() => {
    if (!ref.current || document.activeElement === ref.current) return;
    if (lastValue.current !== value) {
      ref.current.textContent = value ?? "";
      lastValue.current = value ?? "";
    }
  }, [value]);

  return (
    <Tag
      ref={ref}
      className={className}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onPaste={handlePlainTextPaste}
      onBlur={() => {
        if (readOnly) return;
        const next = ref.current?.textContent?.trim() ?? "";
        lastValue.current = next;
        onCommit(next);
      }}
      {...props}
    >
      {value}
    </Tag>
  );
}

function EditableAnswer({ className = "", html, placeholder, onCommit, readOnly = false, ...props }) {
  const isEmpty = !html || html === "<p><br></p>" || html === "<p></p>";
  return (
    <Editable
      className={`${className} ${isEmpty ? "is-empty" : ""}`}
      html={html}
      readOnly={readOnly}
      data-placeholder={placeholder}
      onCommit={(nextHtml) => {
        const plain = nextHtml.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, "").trim();
        onCommit(plain ? nextHtml : "");
      }}
      {...props}
    />
  );
}

function Icon({ children }) {
  return <span className="button-icon" aria-hidden="true">{children}</span>;
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-error">
          <h1>页面出现错误</h1>
          <p>请刷新页面恢复。刚刚编辑的内容仍会优先保存在浏览器本地缓存中。</p>
          <button onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function countItems(chapter) {
  return chapter.sections.reduce((sum, section) => sum + section.items.length, 0);
}

function elementFromNode(node) {
  if (!node) return null;
  if (node.nodeType === 1) return node;
  return node.parentElement ?? null;
}

function App() {
  const [chapters, setChapters] = useState(readStoredContent);
  const [settings, setSettings] = useState(() => ({
    title: "艺术学概论背诵",
    kicker: "艺术学概论 · 随身背诵",
    navTitle: "章节导航",
    sidebarOpen: false,
    reciteMode: false,
    ...readStoredSettings(),
  }));
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [activeChapterId, setActiveChapterId] = useState(null);
  const [draggedChapterId, setDraggedChapterId] = useState(null);
  const [pendingScrollId, setPendingScrollId] = useState(null);
  const [isSavingPermanent, setIsSavingPermanent] = useState(false);
  const [isSavingCloud, setIsSavingCloud] = useState(false);
  const [session, setSession] = useState(null);
  const [isAllowedEditor, setIsAllowedEditor] = useState(!isSupabaseConfigured);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState(isSupabaseConfigured ? "正在检查云端配置" : "本地编辑模式");
  const [undoStack, setUndoStack] = useState([]);
  const [collapsedNavChapters, setCollapsedNavChapters] = useState(() => new Set());
  const fileInputRef = useRef(null);
  const answerSelectionRef = useRef(null);
  const lastSnapshotRef = useRef(null);

  const userEmail = session?.user?.email ?? "";
  const canEdit = isSupabaseConfigured ? isAllowedEditor : true;

  const makeSnapshot = (nextChapters = chapters, nextSettings = settings) => ({
    chapters: JSON.parse(JSON.stringify(nextChapters)),
    settings: JSON.parse(JSON.stringify(nextSettings)),
  });

  const rememberSnapshot = () => {
    if (!canEdit) return;
    const snapshot = makeSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (lastSnapshotRef.current === serialized) return;
    lastSnapshotRef.current = serialized;
    setUndoStack((current) => [...current.slice(-19), snapshot]);
  };

  const applyChaptersChange = (changer) => {
    rememberSnapshot();
    setChapters((current) => typeof changer === "function" ? changer(current) : changer);
  };

  const applySettingsChange = (changer) => {
    rememberSnapshot();
    setSettings((current) => typeof changer === "function" ? changer(current) : changer);
  };

  const undoLastChange = () => {
    setUndoStack((current) => {
      const snapshot = current.at(-1);
      if (!snapshot) {
        setNotice("没有可撤回的修改");
        return current;
      }
      setChapters(snapshot.chapters);
      setSettings(snapshot.settings);
      setNotice("已撤回上一步修改");
      return current.slice(0, -1);
    });
  };

  useEffect(() => {
    let cancelled = false;

    async function loadInitialContent() {
      try {
        if (isSupabaseConfigured) {
          const cloudPayload = await readCloudContent();
          if (!cancelled && cloudPayload) {
            setChapters(cloudPayload.chapters);
            setSettings((current) => ({ ...current, ...cloudPayload.settings }));
            setActiveChapterId(null);
            setCloudStatus("已读取云端内容");
            return;
          }
        }

        const permanentPayload = await readPermanentSave();
        if (!cancelled && permanentPayload) {
          setChapters(permanentPayload.chapters);
          setSettings((current) => ({ ...current, ...permanentPayload.settings }));
          setActiveChapterId(null);
          setCloudStatus(isSupabaseConfigured ? "云端暂无内容，已读取内置内容" : "已读取内置内容");
        }
      } catch {
        if (!cancelled) setCloudStatus("云端读取失败，已使用本地内容");
      }
    }

    loadInitialContent();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let cancelled = false;

    supabase.auth.getSession()
      .then(({ data }) => {
        if (!cancelled) setSession(data.session ?? null);
      })
      .catch(() => {});

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isSupabaseConfigured) {
      setIsAllowedEditor(true);
      return () => {
        cancelled = true;
      };
    }

    if (!userEmail) {
      setIsAllowedEditor(false);
      setCloudStatus("未登录：只读模式");
      return () => {
        cancelled = true;
      };
    }

    checkEditorPermission(userEmail)
      .then((allowed) => {
        if (cancelled) return;
        setIsAllowedEditor(allowed);
        setCloudStatus(allowed ? `已登录：${userEmail} 可编辑` : `已登录：${userEmail} 只读`);
      })
      .catch(() => {
        if (!cancelled) {
          setIsAllowedEditor(false);
          setCloudStatus("权限检查失败：只读模式");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userEmail]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chapters));
  }, [chapters]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 1600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const captureAnswerSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const startElement = elementFromNode(range.startContainer);
      const endElement = elementFromNode(range.endContainer);
      const startItem = startElement?.closest("[data-item-id]");
      const endItem = endElement?.closest("[data-item-id]");
      const answer = startItem?.querySelector(".item-answer");

      if (!startItem || startItem !== endItem || !answer || !answer.contains(startElement) || !answer.contains(endElement)) {
        return;
      }

      answerSelectionRef.current = range.cloneRange();
    };

    document.addEventListener("selectionchange", captureAnswerSelection);
    return () => document.removeEventListener("selectionchange", captureAnswerSelection);
  }, []);

  useEffect(() => {
    if (activeChapterId && !chapters.some((chapter) => chapter.id === activeChapterId)) {
      setActiveChapterId(null);
    }
  }, [activeChapterId, chapters]);

  useEffect(() => {
    if (!pendingScrollId) return undefined;
    const timer = window.setTimeout(() => {
      document.getElementById(pendingScrollId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingScrollId(null);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [pendingScrollId, activeChapterId]);

  const selectedChapter = chapters.find((chapter) => chapter.id === activeChapterId) ?? null;
  const chaptersInView = selectedChapter ? [selectedChapter] : [];

  const visibleChapters = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return chaptersInView;
    return chaptersInView
      .map((chapter) => {
        if (chapter.title.toLowerCase().includes(normalized)) return chapter;
        return {
          ...chapter,
          sections: chapter.sections
            .map((section) => {
              if (section.title.toLowerCase().includes(normalized)) return section;
              return {
                ...section,
                items: section.items.filter((item) =>
                  `${item.question} ${item.answerHtml}`.toLowerCase().includes(normalized),
                ),
              };
            })
            .filter((section) => section.items.length > 0),
        };
      })
      .filter((chapter) =>
        chapter.sections.length > 0,
      );
  }, [chaptersInView, query]);

  const itemCount = chapters.reduce((sum, chapter) => sum + countItems(chapter), 0);
  const sectionCount = chapters.reduce((sum, chapter) => sum + chapter.sections.length, 0);
  const maskedCount = chapters.reduce(
    (sum, chapter) => sum + chapter.sections.reduce(
      (sectionSum, section) => sectionSum + section.items.filter((item) => item.maskedAnswer || item.maskedQuestion).length,
      0,
    ),
    0,
  );

  const updateChapter = (chapterId, updater) => {
    applyChaptersChange((current) => current.map((chapter) => chapter.id === chapterId ? updater(chapter) : chapter));
  };

  const updateSection = (chapterId, sectionId, updater) => {
    updateChapter(chapterId, (chapter) => ({
      ...chapter,
      sections: chapter.sections.map((section) => section.id === sectionId ? updater(section) : section),
    }));
  };

  const updateItem = (chapterId, sectionId, itemId, updater) => {
    updateSection(chapterId, sectionId, (section) => ({
      ...section,
      items: section.items.map((item) => item.id === itemId ? updater(item) : item),
    }));
  };

  const setMaskState = (chapterId, sectionId, itemId, updater) => {
    setChapters((current) => current.map((chapter) => chapter.id !== chapterId ? chapter : ({
      ...chapter,
      sections: chapter.sections.map((section) => section.id !== sectionId ? section : ({
        ...section,
        items: section.items.map((item) => item.id === itemId ? updater(item) : item),
      })),
    })));
  };

  const addChapter = () => {
    if (!canEdit) {
      setNotice("只读模式：请用授权邮箱登录后再修改");
      return;
    }
    const chapter = {
      id: uid("chapter"),
      title: "",
      source: "手动添加",
      sections: [{ id: uid("section"), title: "", items: [] }],
    };
    applyChaptersChange((current) => [...current, chapter]);
    setActiveChapterId(chapter.id);
    setNotice("已新增章节");
  };

  const addSection = (chapterId) => {
    if (!canEdit) {
      setNotice("只读模式：请用授权邮箱登录后再修改");
      return;
    }
    updateChapter(chapterId, (chapter) => ({
      ...chapter,
      sections: [...chapter.sections, { id: uid("section"), title: "", items: [] }],
    }));
    setNotice("已新增小节");
  };

  const addItem = (chapterId, sectionId) => {
    if (!canEdit) {
      setNotice("只读模式：请用授权邮箱登录后再修改");
      return;
    }
    const item = {
      id: uid("item"),
      question: "",
      answerHtml: "",
      maskedQuestion: false,
      maskedAnswer: false,
    };
    updateSection(chapterId, sectionId, (section) => ({ ...section, items: [...section.items, item] }));
    setNotice("已新增背诵条目");
  };

  const removeItem = (chapterId, sectionId, itemId) => {
    if (!canEdit) return;
    if (!window.confirm("确定删除这个背诵条目吗？")) return;
    updateSection(chapterId, sectionId, (section) => ({ ...section, items: section.items.filter((item) => item.id !== itemId) }));
    setNotice("已删除条目");
  };

  const removeSection = (chapterId, sectionId) => {
    if (!canEdit) return;
    if (!window.confirm("确定删除这个小节及其中的条目吗？")) return;
    updateChapter(chapterId, (chapter) => ({
      ...chapter,
      sections: chapter.sections.filter((section) => section.id !== sectionId),
    }));
    setNotice("已删除小节");
  };

  const removeChapter = (chapterId) => {
    if (!canEdit) return;
    if (!window.confirm("确定删除整个章节及其中的内容吗？")) return;
    applyChaptersChange((current) => current.filter((chapter) => chapter.id !== chapterId));
    if (activeChapterId === chapterId) setActiveChapterId(null);
    setNotice("已删除章节");
  };

  const moveChapter = (chapterId, direction) => {
    if (!canEdit) return;
    applyChaptersChange((current) => {
      const fromIndex = current.findIndex((chapter) => chapter.id === chapterId);
      const toIndex = fromIndex + direction;
      if (fromIndex < 0 || toIndex < 0 || toIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setNotice("章节顺序已更新");
  };

  const reorderChapter = (fromId, toId) => {
    if (!canEdit) return;
    if (!fromId || !toId || fromId === toId) return;
    applyChaptersChange((current) => {
      const fromIndex = current.findIndex((chapter) => chapter.id === fromId);
      const toIndex = current.findIndex((chapter) => chapter.id === toId);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setDraggedChapterId(null);
    setNotice("章节顺序已更新");
  };

  const openHome = () => {
    setActiveChapterId(null);
    setPendingScrollId(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openChapter = (chapterId, scrollId = null) => {
    setActiveChapterId(chapterId);
    setPendingScrollId(scrollId ?? chapterId);
    setSettings((current) => ({ ...current, sidebarOpen: false }));
  };

  const toggleNavChapter = (chapterId) => {
    setCollapsedNavChapters((current) => {
      const next = new Set(current);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  };

  const toggleAllAnswers = () => {
    const shouldMask = chapters.some((chapter) => chapter.sections.some((section) => section.items.some((item) => !item.maskedAnswer)));
    setChapters((current) => current.map((chapter) => ({
      ...chapter,
      sections: chapter.sections.map((section) => ({
        ...section,
        items: section.items.map((item) => ({ ...item, maskedAnswer: shouldMask })),
      })),
    })));
    setSettings((current) => ({ ...current, reciteMode: true }));
    setNotice(shouldMask ? "已遮挡全部答案" : "已显示全部答案");
  };

  const revealAll = () => {
    setChapters((current) => current.map((chapter) => ({
      ...chapter,
      sections: chapter.sections.map((section) => ({
        ...section,
        items: section.items.map((item) => ({ ...item, maskedQuestion: false, maskedAnswer: false })),
      })),
    })));
    setNotice("已显示全部内容");
  };

  const resetContent = () => {
    if (!window.confirm("恢复原始 Markdown 内容？本地编辑、手动添加和遮挡状态都会清除。")) return;
    rememberSnapshot();
    setChapters(getInitialContent());
    setActiveChapterId(null);
    setSettings((current) => ({ ...current, title: "艺术学概论背诵" }));
    setNotice("已恢复原始内容");
  };

  const exportBackup = () => {
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      settings,
      chapters,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "艺术学概论背诵备份.json";
    link.click();
    URL.revokeObjectURL(url);
    setNotice("备份已导出");
  };

  const savePermanent = async () => {
    const payload = {
      version: 2,
      savedAt: new Date().toISOString(),
      settings,
      chapters,
    };
    setIsSavingPermanent(true);
    try {
      const response = await fetch("/api/save-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("save endpoint unavailable");
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || "save failed");
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chapters));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      setNotice("已永久保存到网页文件");
    } catch {
      setNotice("当前环境不能直接写文件，请使用“导出备份”");
    } finally {
      setIsSavingPermanent(false);
    }
  };

  const saveToCloud = async () => {
    if (!isSupabaseConfigured) {
      setNotice("未配置 Supabase，无法云端保存");
      return;
    }
    if (!canEdit) {
      setNotice("只读模式：请用授权邮箱登录后再云端保存");
      return;
    }

    const payload = {
      version: 2,
      savedAt: new Date().toISOString(),
      settings,
      chapters,
    };

    setIsSavingCloud(true);
    try {
      await saveCloudContent(payload);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chapters));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      setCloudStatus(`云端已保存：${new Date().toLocaleString()}`);
      setNotice("已云端保存");
    } catch (error) {
      setNotice(`云端保存失败：${error.message}`);
    } finally {
      setIsSavingCloud(false);
    }
  };

  const signIn = async (event) => {
    event.preventDefault();
    if (!supabase) {
      setNotice("未配置 Supabase");
      return;
    }
    setIsAuthBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: authEmail.trim(),
        password: authPassword,
      });
      if (error) throw error;
      setAuthPassword("");
      setNotice("登录成功，正在检查编辑权限");
    } catch (error) {
      setNotice(`登录失败：${error.message}`);
    } finally {
      setIsAuthBusy(false);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    setIsAuthBusy(true);
    try {
      await supabase.auth.signOut();
      setSession(null);
      setIsAllowedEditor(false);
      setNotice("已退出登录");
    } finally {
      setIsAuthBusy(false);
    }
  };

  const importBackup = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result);
        if (!Array.isArray(payload.chapters)) throw new Error("invalid");
        setChapters(payload.chapters);
        setActiveChapterId(null);
        if (payload.settings) setSettings((current) => ({ ...current, ...payload.settings }));
        setNotice("备份已导入，可点击“保存到网页文件”永久保留");
      } catch {
        setNotice("备份文件格式不正确");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  };

  const maskSelection = () => {
    const selection = window.getSelection();
    const currentRange = selection && selection.rangeCount > 0 && !selection.isCollapsed
      ? selection.getRangeAt(0).cloneRange()
      : null;
    const range = currentRange ?? answerSelectionRef.current?.cloneRange();

    if (!range) {
      setNotice("请先选中正文中的文字");
      return;
    }
    const startElement = elementFromNode(range.startContainer);
    const endElement = elementFromNode(range.endContainer);
    const startItem = startElement?.closest("[data-item-id]");
    const endItem = endElement?.closest("[data-item-id]");
    const answer = startItem?.querySelector(".item-answer");

    if (!startItem || startItem !== endItem || !answer || !answer.contains(startElement) || !answer.contains(endElement)) {
      setNotice("请在同一个答案中选择文字");
      return;
    }
    const span = document.createElement("span");
    span.className = "masked-text";
    try {
      range.surroundContents(span);
    } catch {
      span.appendChild(range.extractContents());
      range.insertNode(span);
    }
    selection?.removeAllRanges();
    const chapterId = startItem.dataset.chapterId;
    const sectionId = startItem.dataset.sectionId;
    const itemId = startItem.dataset.itemId;
    const answerHtml = answer.innerHTML;
    answerSelectionRef.current = null;
    updateItem(chapterId, sectionId, itemId, (item) => ({ ...item, answerHtml }));
    setSettings((current) => ({ ...current, reciteMode: true }));
    setNotice("已遮挡选中文字，点击色块可显示");
  };

  return (
    <div className={`app-shell ${settings.sidebarOpen ? "sidebar-open" : ""} ${settings.reciteMode ? "recite-mode" : ""}`}>
      <header className="topbar">
        <button className="icon-button" onClick={() => setSettings((current) => ({ ...current, sidebarOpen: !current.sidebarOpen }))} title="展开或隐藏章节导航">
          <Icon>{settings.sidebarOpen ? "×" : "☰"}</Icon>
          <span className="sr-only">章节导航</span>
        </button>
        <div className="brand">
          <Editable className="kicker" html={settings.kicker} readOnly={!canEdit} onCommit={(html) => applySettingsChange((current) => ({ ...current, kicker: html }))} />
          <Editable className="page-title" tagName="h1" html={settings.title} readOnly={!canEdit} onCommit={(html) => applySettingsChange((current) => ({ ...current, title: html }))} />
        </div>
        <div className="top-actions">
          {isSupabaseConfigured && (
            <form className="auth-panel" onSubmit={signIn}>
              {userEmail ? (
                <>
                  <span className={`auth-badge ${canEdit ? "editor" : "readonly"}`}>{canEdit ? "可编辑" : "只读"}：{userEmail}</span>
                  <button className="action-button" type="button" onClick={signOut} disabled={isAuthBusy}>退出</button>
                </>
              ) : (
                <>
                  <input className="auth-input" type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="授权邮箱" autoComplete="email" />
                  <input className="auth-input" type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="密码" autoComplete="current-password" />
                  <button className="action-button primary" type="submit" disabled={isAuthBusy}>{isAuthBusy ? "登录中" : "登录"}</button>
                </>
              )}
            </form>
          )}
          <button className={`action-button ${settings.reciteMode ? "selected" : "primary"}`} onClick={() => setSettings((current) => ({ ...current, reciteMode: !current.reciteMode }))}>
            <Icon>◉</Icon>背诵模式
          </button>
          <button className="action-button" onClick={toggleAllAnswers}><Icon>▣</Icon>遮挡答案</button>
          <button className="action-button" onMouseDown={(event) => event.preventDefault()} onClick={maskSelection}><Icon>✦</Icon>遮挡选中</button>
          <button className="action-button" onClick={revealAll}><Icon>○</Icon>全部显示</button>
          <button className="action-button" onClick={undoLastChange} disabled={!canEdit || undoStack.length === 0}><Icon>↶</Icon>撤回</button>
          {isSupabaseConfigured && <button className="action-button" onClick={saveToCloud} disabled={!canEdit || isSavingCloud}><Icon>☁</Icon>{isSavingCloud ? "云端保存中" : "云端保存"}</button>}
          {!isSupabaseConfigured && <button className="action-button" onClick={savePermanent} disabled={isSavingPermanent}><Icon>✓</Icon>{isSavingPermanent ? "保存中" : "保存到网页文件"}</button>}
          <button className="action-button" onClick={exportBackup}><Icon>↓</Icon>导出备份</button>
          <button className="action-button" onClick={() => fileInputRef.current?.click()} disabled={!canEdit}><Icon>↑</Icon>导入备份</button>
          <button className="action-button subtle" onClick={resetContent} disabled={!canEdit}>重置</button>
          <input ref={fileInputRef} type="file" accept="application/json" onChange={importBackup} hidden />
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <Editable className="sidebar-title" html={settings.navTitle} readOnly={!canEdit} onCommit={(html) => applySettingsChange((current) => ({ ...current, navTitle: html }))} />
            <button className="icon-button small" onClick={() => setSettings((current) => ({ ...current, sidebarOpen: false }))} title="隐藏目录"><Icon>×</Icon></button>
          </div>
          <div className="sidebar-actions">
            <button className="small-button" onClick={addChapter} disabled={!canEdit}><Icon>＋</Icon>新增章节</button>
          </div>
          <nav className="chapter-nav">
            <button className={`nav-home ${!activeChapterId ? "active" : ""}`} onClick={openHome}>
              <Icon>⌂</Icon>首页
            </button>
            {chapters.map((chapter, chapterIndex) => {
              const navCollapsed = collapsedNavChapters.has(chapter.id);
              return (
                <div
                  className={`nav-chapter ${activeChapterId === chapter.id ? "active" : ""} ${draggedChapterId === chapter.id ? "dragging" : ""}`}
                  key={chapter.id}
                  draggable={canEdit}
                  onDragStart={() => setDraggedChapterId(chapter.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => reorderChapter(draggedChapterId, chapter.id)}
                  onDragEnd={() => setDraggedChapterId(null)}
                >
                  <div className="chapter-nav-row">
                    <button className="chapter-switch" onClick={() => openChapter(chapter.id)}>
                      <span className="drag-handle" title="拖拽调整章节顺序">☰</span>
                      <span className="chapter-switch-title">{chapter.title || "未命名章节"}</span>
                      <span className="chapter-count">{countItems(chapter)}</span>
                    </button>
                    <button
                      className="nav-toggle"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleNavChapter(chapter.id);
                      }}
                      title={navCollapsed ? "展开小层级" : "收起小层级"}
                    >
                      {navCollapsed ? "▸" : "▾"}
                    </button>
                  </div>
                  {!navCollapsed && (
                    <>
                      <div className="chapter-order-tools">
                        <button className="mini-button" disabled={!canEdit || chapterIndex === 0} onClick={() => moveChapter(chapter.id, -1)}>上移</button>
                        <button className="mini-button" disabled={!canEdit || chapterIndex === chapters.length - 1} onClick={() => moveChapter(chapter.id, 1)}>下移</button>
                      </div>
                      <div className="nav-sections">
                        {chapter.sections.map((section) => (
                          <div className="nav-section" key={section.id}>
                            <button className="nav-section-link" onClick={() => openChapter(chapter.id, section.id)}>{section.title || "未命名小节"}</button>
                            <div className="nav-items">
                              {section.items.map((item) => <button key={item.id} onClick={() => openChapter(chapter.id, item.id)}>{item.question || "未命名题目"}</button>)}
                              {section.items.length === 0 && <em>暂无条目</em>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </nav>
        </aside>

        <main className="content">
          <div className="content-toolbar">
            <div className="stats"><strong>{chapters.length}</strong> 章节 · <strong>{sectionCount}</strong> 小节 · <strong>{itemCount}</strong> 条目 · 已遮挡 <strong>{maskedCount}</strong> 项</div>
            <label className="search-box"><Icon>⌕</Icon><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索题目或答案" /></label>
          </div>
          <div className={`cloud-status ${canEdit ? "editable" : "readonly"}`}>{cloudStatus}</div>

          {!activeChapterId && (
            <section className="home-panel">
              <div className="home-copy">
                <h2>首页</h2>
                <p>选择左侧章节，或点击下方章节卡片开始背诵。进入章节后只显示当前章节内容。</p>
              </div>
              <div className="home-grid">
                {chapters.map((chapter) => (
                  <button className="home-card" key={chapter.id} onClick={() => openChapter(chapter.id)}>
                    <span>{chapter.title || "未命名章节"}</span>
                    <small>{chapter.sections.length} 个小节 · {countItems(chapter)} 个条目</small>
                  </button>
                ))}
                {chapters.length === 0 && <div className="empty-state">还没有章节，点击左侧“新增章节”开始整理。</div>}
              </div>
            </section>
          )}

          {visibleChapters.map((chapter) => (
            <section className="chapter" id={chapter.id} key={chapter.id}>
              <div className="chapter-heading">
                <EditableText className="chapter-title" tagName="h2" value={chapter.title} placeholder="输入章节名称" readOnly={!canEdit} onCommit={(value) => updateChapter(chapter.id, (current) => ({ ...current, title: value }))} />
                <div className="chapter-tools">
                  <button className="small-button" onClick={() => addSection(chapter.id)} disabled={!canEdit}><Icon>＋</Icon>新增小节</button>
                  <button className="icon-button small danger" onClick={() => removeChapter(chapter.id)} disabled={!canEdit} title="删除章节"><Icon>⌫</Icon></button>
                </div>
              </div>

              {chapter.sections.map((section) => (
                <section className="content-section" id={section.id} key={section.id}>
                  <div className="section-heading">
                    <EditableText className="section-title" tagName="h3" value={section.title} placeholder="输入小节名称" readOnly={!canEdit} onCommit={(value) => updateSection(chapter.id, section.id, (current) => ({ ...current, title: value }))} />
                    <div className="section-tools">

                      <button className="icon-button small danger" onClick={() => removeSection(chapter.id, section.id)} disabled={!canEdit} title="删除小节"><Icon>⌫</Icon></button>
                    </div>
                  </div>
                  <div className="items">
                    {section.items.map((item) => (
                      <article
                        className={`study-item ${item.maskedQuestion ? "mask-question" : ""} ${item.maskedAnswer ? "mask-answer" : ""}`}
                        id={item.id}
                        key={item.id}
                        data-item-id={item.id}
                        data-section-id={section.id}
                        data-chapter-id={chapter.id}
                      >
                        <div className="item-header">
                          <EditableText className="item-question" tagName="h4" value={item.question} placeholder="输入题目" readOnly={!canEdit} onCommit={(value) => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, question: value }))} />
                          <div className="item-actions">
                            {settings.reciteMode && (
                              <>
                                <button className="small-button" onClick={() => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, maskedQuestion: !current.maskedQuestion }))}>{item.maskedQuestion ? "显示题目" : "遮挡题目"}</button>
                                <button className="small-button" onClick={() => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, maskedAnswer: !current.maskedAnswer }))}>{item.maskedAnswer ? "显示答案" : "遮挡答案"}</button>
                              </>
                            )}
                            <button className="icon-button small danger" onClick={() => removeItem(chapter.id, section.id, item.id)} disabled={!canEdit} title="删除条目"><Icon>⌫</Icon></button>
                          </div>
                        </div>
                        <EditableAnswer
                          className="item-answer"
                          html={item.answerHtml}
                          placeholder="输入答案"
                          readOnly={!canEdit}
                          onClick={(event) => {
                            const target = event.target.closest?.(".masked-text");
                            if (!target) return;
                            target.classList.toggle("revealed");
                            const answerHtml = event.currentTarget.innerHTML;
                            updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, answerHtml }));
                          }}
                          onCommit={(html) => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, answerHtml: html }))}
                        />
                        {(item.maskedQuestion || item.maskedAnswer) && <button className="reveal-hint" onClick={() => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, maskedQuestion: false, maskedAnswer: false }))}>点击显示</button>}
                      </article>
                    ))}
                    {section.items.length === 0 && <div className="empty-chapter">??????????</div>}
                    <button className="add-item-tail" onClick={() => addItem(chapter.id, section.id)} disabled={!canEdit}><Icon>＋</Icon>新增题目</button>
                  </div>
                </section>
              ))}
            </section>
          ))}
          {activeChapterId && visibleChapters.length === 0 && <div className="empty-state">没有找到匹配内容。</div>}
        </main>
      </div>
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
