import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const markdownFiles = import.meta.glob("../*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const STORAGE_KEY = "art-recite-react-v2";
const SETTINGS_KEY = "art-recite-settings-v2";
const PERMANENT_SAVE_URL = "/saved-content.json";

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

function Editable({ className = "", html, onCommit, tagName: Tag = "div", ...props }) {
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
      contentEditable
      suppressContentEditableWarning
      dangerouslySetInnerHTML={{ __html: html }}
      onBlur={() => {
        const next = ref.current?.innerHTML ?? "";
        lastHtml.current = next;
        onCommit(next);
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
  const fileInputRef = useRef(null);
  const answerSelectionRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    readPermanentSave()
      .then((payload) => {
        if (cancelled || !payload) return;
        setChapters(payload.chapters);
        setSettings((current) => ({ ...current, ...payload.settings }));
        setActiveChapterId(null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
    setChapters((current) => current.map((chapter) => chapter.id === chapterId ? updater(chapter) : chapter));
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

  const addChapter = () => {
    const chapter = {
      id: uid("chapter"),
      title: "新章节",
      source: "手动添加",
      sections: [{ id: uid("section"), title: "知识点", items: [] }],
    };
    setChapters((current) => [...current, chapter]);
    setActiveChapterId(chapter.id);
    setNotice("已新增章节");
  };

  const addSection = (chapterId) => {
    updateChapter(chapterId, (chapter) => ({
      ...chapter,
      sections: [...chapter.sections, { id: uid("section"), title: "新小节", items: [] }],
    }));
    setNotice("已新增小节");
  };

  const addItem = (chapterId, sectionId) => {
    const item = {
      id: uid("item"),
      question: "新题目",
      answerHtml: "<p>在这里输入答案。</p>",
      maskedQuestion: false,
      maskedAnswer: false,
    };
    updateSection(chapterId, sectionId, (section) => ({ ...section, items: [...section.items, item] }));
    setNotice("已新增背诵条目");
  };

  const removeItem = (chapterId, sectionId, itemId) => {
    if (!window.confirm("确定删除这个背诵条目吗？")) return;
    updateSection(chapterId, sectionId, (section) => ({ ...section, items: section.items.filter((item) => item.id !== itemId) }));
    setNotice("已删除条目");
  };

  const removeSection = (chapterId, sectionId) => {
    if (!window.confirm("确定删除这个小节及其中的条目吗？")) return;
    updateChapter(chapterId, (chapter) => ({
      ...chapter,
      sections: chapter.sections.filter((section) => section.id !== sectionId),
    }));
    setNotice("已删除小节");
  };

  const removeChapter = (chapterId) => {
    if (!window.confirm("确定删除整个章节及其中的内容吗？")) return;
    setChapters((current) => current.filter((chapter) => chapter.id !== chapterId));
    if (activeChapterId === chapterId) setActiveChapterId(null);
    setNotice("已删除章节");
  };

  const moveChapter = (chapterId, direction) => {
    setChapters((current) => {
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
    if (!fromId || !toId || fromId === toId) return;
    setChapters((current) => {
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
          <Editable className="kicker" html={settings.kicker} onCommit={(html) => setSettings((current) => ({ ...current, kicker: html }))} />
          <Editable className="page-title" tagName="h1" html={settings.title} onCommit={(html) => setSettings((current) => ({ ...current, title: html }))} />
        </div>
        <div className="top-actions">
          <button className={`action-button ${settings.reciteMode ? "selected" : "primary"}`} onClick={() => setSettings((current) => ({ ...current, reciteMode: !current.reciteMode }))}>
            <Icon>◉</Icon>背诵模式
          </button>
          <button className="action-button" onClick={toggleAllAnswers}><Icon>▣</Icon>遮挡答案</button>
          <button className="action-button" onMouseDown={(event) => event.preventDefault()} onClick={maskSelection}><Icon>✦</Icon>遮挡选中</button>
          <button className="action-button" onClick={revealAll}><Icon>○</Icon>全部显示</button>
          <button className="action-button" onClick={savePermanent} disabled={isSavingPermanent}><Icon>✓</Icon>{isSavingPermanent ? "保存中" : "保存到网页文件"}</button>
          <button className="action-button" onClick={exportBackup}><Icon>↓</Icon>导出备份</button>
          <button className="action-button" onClick={() => fileInputRef.current?.click()}><Icon>↑</Icon>导入备份</button>
          <button className="action-button subtle" onClick={resetContent}>重置</button>
          <input ref={fileInputRef} type="file" accept="application/json" onChange={importBackup} hidden />
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <Editable className="sidebar-title" html={settings.navTitle} onCommit={(html) => setSettings((current) => ({ ...current, navTitle: html }))} />
            <button className="icon-button small" onClick={() => setSettings((current) => ({ ...current, sidebarOpen: false }))} title="隐藏目录"><Icon>×</Icon></button>
          </div>
          <div className="sidebar-actions">
            <button className="small-button" onClick={addChapter}><Icon>＋</Icon>新增章节</button>
          </div>
          <nav className="chapter-nav">
            <button className={`nav-home ${!activeChapterId ? "active" : ""}`} onClick={openHome}>
              <Icon>⌂</Icon>首页
            </button>
            {chapters.map((chapter, chapterIndex) => (
              <div
                className={`nav-chapter ${activeChapterId === chapter.id ? "active" : ""} ${draggedChapterId === chapter.id ? "dragging" : ""}`}
                key={chapter.id}
                draggable
                onDragStart={() => setDraggedChapterId(chapter.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => reorderChapter(draggedChapterId, chapter.id)}
                onDragEnd={() => setDraggedChapterId(null)}
              >
                <details open={activeChapterId === chapter.id || !activeChapterId}>
                  <summary>
                    <button className="chapter-switch" onClick={(event) => { event.preventDefault(); openChapter(chapter.id); }}>
                      <span className="drag-handle" title="拖拽调整章节顺序">☰</span>
                      <span className="chapter-switch-title">{chapter.title || "未命名章节"}</span>
                      <span className="chapter-count">{countItems(chapter)}</span>
                    </button>
                  </summary>
                  <div className="chapter-order-tools">
                    <button className="mini-button" disabled={chapterIndex === 0} onClick={() => moveChapter(chapter.id, -1)}>上移</button>
                    <button className="mini-button" disabled={chapterIndex === chapters.length - 1} onClick={() => moveChapter(chapter.id, 1)}>下移</button>
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
                </details>
              </div>
            ))}
          </nav>
        </aside>

        <main className="content">
          <div className="content-toolbar">
            <div className="stats"><strong>{chapters.length}</strong> 章节 · <strong>{sectionCount}</strong> 小节 · <strong>{itemCount}</strong> 条目 · 已遮挡 <strong>{maskedCount}</strong> 项</div>
            <label className="search-box"><Icon>⌕</Icon><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索题目或答案" /></label>
          </div>

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
                <Editable className="chapter-title" tagName="h2" html={chapter.title} onCommit={(html) => updateChapter(chapter.id, (current) => ({ ...current, title: html }))} />
                <div className="chapter-tools">
                  <button className="small-button" onClick={() => addSection(chapter.id)}><Icon>＋</Icon>新增小节</button>
                  <button className="icon-button small danger" onClick={() => removeChapter(chapter.id)} title="删除章节"><Icon>⌫</Icon></button>
                </div>
              </div>

              {chapter.sections.map((section) => (
                <section className="content-section" id={section.id} key={section.id}>
                  <div className="section-heading">
                    <Editable className="section-title" tagName="h3" html={section.title} onCommit={(html) => updateSection(chapter.id, section.id, (current) => ({ ...current, title: html }))} />
                    <div className="section-tools">
                      <button className="small-button" onClick={() => addItem(chapter.id, section.id)}><Icon>＋</Icon>新增题目</button>
                      <button className="icon-button small danger" onClick={() => removeSection(chapter.id, section.id)} title="删除小节"><Icon>⌫</Icon></button>
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
                          <Editable className="item-question" tagName="h4" html={item.question} onCommit={(html) => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, question: html }))} />
                          <div className="item-actions">
                            {settings.reciteMode && (
                              <>
                                <button className="small-button" onClick={() => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, maskedQuestion: !current.maskedQuestion }))}>{item.maskedQuestion ? "显示题目" : "遮挡题目"}</button>
                                <button className="small-button" onClick={() => updateItem(chapter.id, section.id, item.id, (current) => ({ ...current, maskedAnswer: !current.maskedAnswer }))}>{item.maskedAnswer ? "显示答案" : "遮挡答案"}</button>
                              </>
                            )}
                            <button className="icon-button small danger" onClick={() => removeItem(chapter.id, section.id, item.id)} title="删除条目"><Icon>⌫</Icon></button>
                          </div>
                        </div>
                        <Editable
                          className="item-answer"
                          html={item.answerHtml}
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
                    {section.items.length === 0 && <div className="empty-chapter">这个小节还没有内容，点击“新增题目”开始整理。</div>}
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
