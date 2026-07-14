import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  Copy,
  Database,
  Download,
  FileCode2,
  HelpCircle,
  Image as ImageIcon,
  Languages,
  Menu,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { ViewState } from '../App';
import {
  helpCategoryLabels,
  helpFaqs,
  helpTemplates,
  publicAiDrawingPrompts,
  quickStartSteps,
  type HelpCategoryId,
  type PublicPromptLanguage,
} from '../content/helpContent';
import { copyTextToClipboard } from '../utils/clipboard';
import { LandingAuthDialog, type LandingAuthMode } from './LandingAuthDialog';

interface HelpCenterPageProps {
  onNavigate: (view: ViewState) => void;
  publicMode?: boolean;
  onAuthenticated?: () => void;
}

type TemplateTab = 'preview' | 'python' | 'r' | 'data';

const categoryIcons: Record<HelpCategoryId, typeof BookOpen> = {
  quick_start: Play,
  templates: ImageIcon,
  code_rules: Code2,
  ai_translation: Languages,
  editing_export: Download,
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    const copied = await copyTextToClipboard(value);
    setCopyStatus(copied ? 'copied' : 'failed');
    window.setTimeout(() => setCopyStatus('idle'), 1800);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-9 items-center gap-2 border border-white/15 bg-white/[0.06] px-3 text-xs font-bold text-white transition hover:border-[#8de6d1]/60 hover:bg-[#8de6d1]/10"
      aria-label={label}
    >
      {copyStatus === 'copied' ? <Check className="h-3.5 w-3.5 text-[#8de6d1]" /> : <Copy className="h-3.5 w-3.5" />}
      {copyStatus === 'copied' ? '已复制' : copyStatus === 'failed' ? '复制失败' : label}
    </button>
  );
}

export function HelpCenterPage({ onNavigate, publicMode = false, onAuthenticated }: HelpCenterPageProps) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<HelpCategoryId | 'all'>('all');
  const [openFaqs, setOpenFaqs] = useState<Set<string>>(new Set());
  const [activeTemplateId, setActiveTemplateId] = useState(helpTemplates[0]?.id ?? '');
  const [templateTab, setTemplateTab] = useState<TemplateTab>('preview');
  const [promptLanguage, setPromptLanguage] = useState<PublicPromptLanguage>('python');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<LandingAuthMode>('register');

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const filteredFaqs = useMemo(() => helpFaqs.filter((faq) => {
    if (activeCategory !== 'all' && faq.category !== activeCategory) return false;
    if (!normalizedQuery) return true;
    const answer = Array.isArray(faq.answer) ? faq.answer.join(' ') : faq.answer;
    return `${faq.question} ${answer} ${helpCategoryLabels[faq.category]}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery);
  }), [activeCategory, normalizedQuery]);

  const filteredTemplates = useMemo(() => helpTemplates.filter((template) => {
    if (!normalizedQuery) return true;
    return `${template.title} ${template.description} ${template.highlights.join(' ')}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery);
  }), [normalizedQuery]);

  const activeTemplate = helpTemplates.find((item) => item.id === activeTemplateId) ?? helpTemplates[0];
  const allVisibleOpen = filteredFaqs.length > 0 && filteredFaqs.every((faq) => openFaqs.has(faq.id));

  const openAuth = (mode: LandingAuthMode) => {
    setAuthMode(mode);
    setAuthOpen(true);
  };

  const start = () => {
    if (publicMode) openAuth('register');
    else onNavigate('project_create');
  };

  const toggleFaq = (id: string) => {
    setOpenFaqs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setOpenFaqs((current) => {
      const next = new Set(current);
      if (allVisibleOpen) filteredFaqs.forEach((faq) => next.delete(faq.id));
      else filteredFaqs.forEach((faq) => next.add(faq.id));
      return next;
    });
  };

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setMobileNavOpen(false);
  };

  return (
    <div className="help-center-page flex-1 overflow-y-auto bg-[#f3f5f4] text-[#10231f] antialiased">
      <section className="relative min-h-[72svh] overflow-hidden bg-[#071411] text-white">
        <div className="help-hero-grid absolute inset-0 opacity-55" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_76%_18%,rgba(141,230,209,0.18),transparent_32%),linear-gradient(120deg,rgba(7,20,17,0.2),rgba(7,20,17,0.96)_62%)]" />
        <div className="help-orbit help-orbit-one absolute right-[8%] top-24 h-72 w-72 rounded-full border border-[#8de6d1]/20" />
        <div className="help-orbit help-orbit-two absolute right-[14%] top-40 h-44 w-44 rounded-full border border-[#d7b66f]/30" />

        <header className="relative z-20 border-b border-white/10 bg-[#071411]/70 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
            <button type="button" title={publicMode ? '返回官网' : '返回工作区'} aria-label={publicMode ? '返回官网首页' : '返回工作区首页'} onClick={() => onNavigate(publicMode ? 'landing' : 'home')} className="flex items-center gap-2.5 text-left">
              <span className="flex h-9 w-9 items-center justify-center bg-[#8de6d1] text-base font-black text-[#071411]">S</span>
              <span>
                <span className="block text-sm font-black text-white sm:text-base">SciFigure Studio</span>
                <span className="hidden text-[9px] font-bold uppercase text-[#a8d9cd] sm:block">Help center</span>
              </span>
            </button>

            <nav className="hidden items-center gap-1 lg:flex" aria-label="帮助中心导航">
              <button type="button" onClick={() => jumpTo('quick-start')} className="help-nav-link">快速上手</button>
              <button type="button" onClick={() => jumpTo('template-lab')} className="help-nav-link">科研模板</button>
              <button type="button" onClick={() => jumpTo('standards')} className="help-nav-link">代码规范</button>
              <button type="button" onClick={() => jumpTo('faq')} className="help-nav-link">帮助问答</button>
            </nav>

            <div className="flex items-center gap-2">
              {publicMode ? (
                <>
                  <button type="button" onClick={() => onNavigate('landing')} className="hidden items-center gap-1.5 px-3 py-2 text-sm font-bold text-white/75 hover:text-white md:inline-flex">
                    <ArrowLeft className="h-4 w-4" /> 返回官网
                  </button>
                  <button type="button" onClick={() => openAuth('login')} className="hidden px-3 py-2 text-sm font-bold text-white/75 hover:text-white sm:block">登录</button>
                  <button type="button" onClick={() => openAuth('register')} className="bg-[#8de6d1] px-3 py-2 text-xs font-black text-[#071411] transition hover:bg-white sm:px-4 sm:text-sm">免费注册</button>
                </>
              ) : (
                <button type="button" onClick={() => onNavigate('home')} className="inline-flex items-center gap-2 border border-white/20 px-3 py-2 text-xs font-bold text-white hover:border-white/50 sm:text-sm">
                  <ArrowLeft className="h-4 w-4" /> 返回工作区
                </button>
              )}
              <button type="button" onClick={() => setMobileNavOpen((value) => !value)} className="flex h-9 w-9 items-center justify-center border border-white/15 text-white lg:hidden" aria-label="打开帮助导航">
                {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <AnimatePresence>
            {mobileNavOpen && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-white/10 bg-[#071411] lg:hidden">
                <div className="grid gap-1 px-4 py-3">
                  {[
                    ...(publicMode ? [['official-site', '返回官网']] : []),
                    ['quick-start', '快速上手'],
                    ['template-lab', '科研模板'],
                    ['standards', '代码规范'],
                    ['faq', '帮助问答'],
                  ].map(([id, label]) => <button key={id} type="button" onClick={() => id === 'official-site' ? onNavigate('landing') : jumpTo(id)} className="px-3 py-2 text-left text-sm font-bold text-white/75">{label}</button>)}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </header>

        <div className="relative z-10 mx-auto flex min-h-[calc(72svh-64px)] max-w-7xl items-center px-6 py-16">
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.65 }} className="max-w-3xl">
            <div className="flex items-center gap-3 text-xs font-black uppercase text-[#8de6d1]">
              <BookOpen className="h-4 w-4" /> Scientific figure handbook
            </div>
            <h1 className="mt-6 text-4xl font-black leading-[1.06] tracking-normal sm:text-5xl md:text-7xl">从第一段代码到<br />可投稿 Figure。</h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-white/65 md:text-lg">
              查流程、找模板、复制示例数据，或确认 Python / R 脚本怎样写才能获得更稳定的图元识别与编辑能力。
            </p>
            <div className="mt-9 max-w-2xl">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8de6d1]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索：多文件、色条、R 语言、导出、图元识别..."
                  className="h-14 w-full border border-white/20 bg-white/[0.08] pl-12 pr-12 text-sm text-white outline-none backdrop-blur-xl placeholder:text-white/40 focus:border-[#8de6d1]"
                />
                {query && <button type="button" onClick={() => setQuery('')} className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-white/50 hover:text-white" aria-label="清空搜索"><X className="h-4 w-4" /></button>}
              </label>
              <div className="mt-3 text-xs text-white/45">可搜索 {helpFaqs.length} 个问答与 {helpTemplates.length} 套可运行模板</div>
            </div>
          </motion.div>
        </div>
      </section>

      <main>
        <section id="quick-start" className="scroll-mt-6 border-b border-[#10231f]/10 bg-[#dfe9e5] px-6 py-20 md:py-24">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-end">
              <motion.div initial={{ opacity: 0, x: -20 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: 0.3 }}>
                <div className="text-xs font-black uppercase text-[#167a65]">01 / Quick start</div>
                <h2 className="mt-4 text-4xl font-black leading-tight md:text-5xl">从你已经拥有的内容开始。</h2>
              </motion.div>
              <p className="max-w-2xl text-sm leading-7 text-[#53645e] lg:justify-self-end">帮助页面向两类用户：已经准备好数据和 Python/R 脚本的人，以及希望直接使用平台示例代码开始画图的人。两条路径最终都会进入同一个项目创建与编辑流程。</p>
            </div>
            <div className="mt-12 grid border-y border-[#10231f]/15 md:grid-cols-2">
              <div className="border-b border-[#10231f]/15 py-7 md:border-b-0 md:border-r md:pr-8">
                <div className="flex items-center gap-3 text-xs font-black uppercase text-[#167a65]"><FileCode2 className="h-4 w-4" /> 已经有脚本和数据</div>
                <h3 className="mt-4 text-xl font-black">直接导入，不需要重新生成代码。</h3>
                <p className="mt-3 text-sm leading-7 text-[#53645e]">Codex、Claude Code、DeepSeek、ChatGPT、Gemini 或本地分析流程写好的 `.py/.R` 都可以作为起点。先放脚本，平台会提示它引用的数据表，再补齐 CSV/Excel 并创建项目。</p>
              </div>
              <div className="py-7 md:pl-8">
                <div className="flex items-center gap-3 text-xs font-black uppercase text-[#a37828]"><BookOpen className="h-4 w-4" /> 想直接开始画图</div>
                <h3 className="mt-4 text-xl font-black">从示例代码和数据结构开始。</h3>
                <p className="mt-3 text-sm leading-7 text-[#53645e]">在“科研模板”中选择接近的图形，复制 Python 或 R 代码与 CSV，替换列名和数据后放入新建项目。模板不是限制，也可以继续手写任何可运行图形。</p>
              </div>
            </div>
            <div className="mt-14 grid border-y border-[#10231f]/15 md:grid-cols-2 xl:grid-cols-4">
              {quickStartSteps.map((step, index) => (
                <motion.article key={step.id} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.08 }} className="group min-h-56 border-b border-[#10231f]/15 p-6 last:border-b-0 md:border-r md:[&:nth-child(2)]:border-r-0 xl:border-b-0 xl:[&:nth-child(2)]:border-r xl:last:border-r-0">
                  <div className="flex items-center justify-between">
                    <span className="text-3xl font-black text-[#167a65]">{String(index + 1).padStart(2, '0')}</span>
                    <ArrowRight className="h-5 w-5 text-[#10231f]/25 transition group-hover:translate-x-1 group-hover:text-[#167a65]" />
                  </div>
                  <h3 className="mt-10 text-xl font-black">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-[#53645e]">{step.description}</p>
                  <ul className="mt-5 space-y-2 border-t border-[#10231f]/10 pt-4">
                    {step.checklist.map((item) => <li key={item} className="flex gap-2 text-xs leading-5 text-[#61706b]"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#167a65]" />{item}</li>)}
                  </ul>
                </motion.article>
              ))}
            </div>
          </div>
        </section>

        <section id="template-lab" className="scroll-mt-6 bg-[#f3f5f4] px-6 py-20 md:py-28">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
              <div>
                <div className="flex items-center gap-2 text-xs font-black uppercase text-[#a37828]"><Sparkles className="h-4 w-4" /> 02 / Template laboratory</div>
                <h2 className="mt-4 text-4xl font-black leading-tight md:text-5xl">不从空白脚本开始。</h2>
              </div>
              <p className="max-w-2xl text-sm leading-7 text-[#53645e] lg:justify-self-end">每套模板都包含真实示例图、CSV 数据以及 Python / R 两种实现。代码遵循平台的图元识别规范，可作为手写脚本的稳定起点。</p>
            </div>

            <div className="mt-10 grid border-y border-[#10231f]/15 py-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-8">
              <div className="flex items-center gap-3 text-sm font-black text-[#167a65]">
                <Code2 className="h-5 w-5" /> 模板不是边界
              </div>
              <p className="mt-3 max-w-4xl text-sm leading-7 text-[#53645e] md:mt-0">
                只要 Python 或 R 脚本能正常生成 Figure，就可以在平台中绘制，并不要求套用现有模板。模板只是常见图形的可靠起点；使用标准 Matplotlib、ggplot2 或基础 R 绘图函数，后续选择和修改会更完整。
              </p>
            </div>

            {filteredTemplates.length === 0 ? (
              <div className="mt-14 border-y border-[#10231f]/15 py-14 text-center text-sm text-[#53645e]">没有匹配的模板，尝试搜索“热图”“回归”或清空关键词。</div>
            ) : (
              <div className="mt-14 grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
                <div className="border-t border-[#10231f]/15">
                  {filteredTemplates.map((template, index) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => { setActiveTemplateId(template.id); setTemplateTab('preview'); }}
                      className={`group flex w-full items-start gap-4 border-b border-[#10231f]/15 px-1 py-5 text-left transition ${activeTemplate?.id === template.id ? 'text-[#167a65]' : 'text-[#10231f] hover:text-[#167a65]'}`}
                    >
                      <span className="pt-0.5 text-xs font-black text-[#a37828]">0{index + 1}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-black">{template.title}</span>
                        <span className="mt-1 block text-xs leading-5 text-[#6a7873]">{template.eyebrow}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {activeTemplate && filteredTemplates.some((item) => item.id === activeTemplate.id) && (
                  <motion.article layout className="min-w-0 overflow-hidden bg-[#0a1915] text-white">
                    <div className="flex flex-col gap-4 border-b border-white/10 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-[10px] font-black uppercase text-[#d7b66f]">{activeTemplate.eyebrow}</div>
                        <h3 className="mt-1 text-xl font-black">{activeTemplate.title}</h3>
                      </div>
                      <div className="flex flex-wrap gap-1" role="tablist" aria-label="模板内容">
                        {([
                          ['preview', '示例图', ImageIcon],
                          ['python', 'Python', FileCode2],
                          ['r', 'R', Code2],
                          ['data', 'CSV', Database],
                        ] as const).map(([id, label, Icon]) => (
                          <button key={id} type="button" role="tab" aria-selected={templateTab === id} onClick={() => setTemplateTab(id)} className={`inline-flex h-9 items-center gap-2 px-3 text-xs font-bold transition ${templateTab === id ? 'bg-[#8de6d1] text-[#071411]' : 'text-white/55 hover:bg-white/[0.06] hover:text-white'}`}>
                            {Icon ? <Icon className="h-3.5 w-3.5" /> : <FileCode2 className="h-3.5 w-3.5" />} {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <AnimatePresence mode="wait">
                      <motion.div key={`${activeTemplate.id}-${templateTab}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                        {templateTab === 'preview' ? (
                          <div className="grid md:grid-cols-[1.28fr_0.72fr]">
                            <div className="flex min-h-[360px] items-center justify-center bg-white p-5">
                              <img src={activeTemplate.image} alt={`${activeTemplate.title}示例图`} className="max-h-[430px] w-full object-contain" />
                            </div>
                            <div className="border-t border-white/10 p-6 md:border-l md:border-t-0">
                              <p className="text-sm leading-7 text-white/65">{activeTemplate.description}</p>
                              <div className="mt-7 space-y-4">
                                {activeTemplate.highlights.map((item) => <div key={item} className="flex gap-3 text-xs leading-5 text-white/70"><Check className="mt-0.5 h-4 w-4 shrink-0 text-[#8de6d1]" />{item}</div>)}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                              <span className="text-xs font-bold text-white/45">{templateTab === 'python' ? 'figure.py' : templateTab === 'r' ? 'figure.R' : 'example_data.csv'}</span>
                              <CopyButton
                                value={templateTab === 'python' ? activeTemplate.pythonCode : templateTab === 'r' ? activeTemplate.rCode : activeTemplate.csvData}
                                label={templateTab === 'data' ? '复制数据' : '复制代码'}
                              />
                            </div>
                            <pre className="help-code-scroll max-h-[520px] overflow-auto p-5 text-xs leading-6 text-[#dce9e5]"><code>{templateTab === 'python' ? activeTemplate.pythonCode : templateTab === 'r' ? activeTemplate.rCode : activeTemplate.csvData}</code></pre>
                          </div>
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </motion.article>
                )}
              </div>
            )}
          </div>
        </section>

        <section id="standards" className="scroll-mt-6 overflow-hidden bg-[#10231f] px-6 py-20 text-white md:py-28">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-14 lg:grid-cols-[0.76fr_1.24fr]">
              <div className="lg:sticky lg:top-8 lg:self-start">
                <div className="flex items-center gap-2 text-xs font-black uppercase text-[#8de6d1]"><ShieldCheck className="h-4 w-4" /> 03 / Stable by design</div>
                <h2 className="mt-4 text-4xl font-black leading-tight md:text-5xl">代码写得越标准，后续越容易改。</h2>
                <p className="mt-6 text-sm leading-7 text-white/55">规范的脚本更容易得到清晰、可修改的图形。使用标准绘图函数、明确的数据文件名，并正确设置标题、坐标轴、图例和色条，可以减少导入后的调整工作。</p>
              </div>
              <div className="border-t border-white/15">
                {[
                  { icon: Database, index: '01', title: '数据入口明确', text: 'Python 单文件可使用 _uploaded_data；多文件必须按原文件名从 _uploaded_file_paths 读取。R 使用 uploaded_file_paths[["filename.csv"]]。' },
                  { icon: Code2, index: '02', title: '优先原生高阶 API', text: '柱图使用 ax.bar，误差棒使用 ax.errorbar，热图使用 imshow 或 pcolormesh。不要手工拼 Rectangle、线段或像素格。' },
                  { icon: Clipboard, index: '03', title: '转义只返回纯代码', text: '让外部 AI 删除绝对路径、__file__、show 与 savefig；不返回 Markdown 围栏、解释文字或本地归档逻辑。' },
                  { icon: ShieldCheck, index: '04', title: '错误要能定位到数据表', text: '读取后立即校验所需列，错误信息包含文件名、缺失列和当前列，避免渲染失败后只能猜原因。' },
                ].map(({ icon: Icon, index, title, text }) => (
                  <motion.div key={title} initial={{ opacity: 0, x: 20 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: 0.3 }} className="grid gap-4 border-b border-white/15 py-7 sm:grid-cols-[48px_1fr_auto] sm:items-start">
                    <span className="text-xs font-black text-[#d7b66f]">{index}</span>
                    <div><h3 className="text-lg font-black">{title}</h3><p className="mt-2 max-w-xl text-sm leading-7 text-white/55">{text}</p></div>
                    <Icon className="hidden h-5 w-5 text-[#8de6d1] sm:block" />
                  </motion.div>
                ))}
              </div>
            </div>

            <div className="mt-20 border-t border-white/15 pt-10">
              <div className="grid gap-8 lg:grid-cols-[0.78fr_1.22fr] lg:items-start">
                <div>
                  <div className="flex items-center gap-2 text-xs font-black uppercase text-[#d7b66f]"><Sparkles className="h-4 w-4" /> AI prompt share</div>
                  <h3 className="mt-4 text-3xl font-black leading-tight">让外部 AI 直接生成平台兼容代码。</h3>
                  <p className="mt-5 text-sm leading-7 text-white/55">把数据文件、绘图要求和对应提示词一起交给 Codex、Claude、DeepSeek、ChatGPT 或 Gemini。生成结果可以直接放入新建项目，不需要再做一次平台转义。</p>
                  <div className="mt-6 border-l-2 border-[#8de6d1] pl-4 text-xs leading-6 text-white/45">提示词已经包含平台需要的代码格式。你只需要补充绘图要求，并把真实数据文件一起提供给 AI。</div>
                </div>
                <div className="min-w-0 border border-white/15 bg-[#071411]">
                  <div className="flex flex-col gap-3 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex" role="tablist" aria-label="AI 绘图提示词语言">
                      {(['python', 'r'] as PublicPromptLanguage[]).map((language) => (
                        <button key={language} type="button" role="tab" aria-selected={promptLanguage === language} onClick={() => setPromptLanguage(language)} className={`h-9 px-4 text-xs font-black transition ${promptLanguage === language ? 'bg-[#8de6d1] text-[#071411]' : 'bg-white/[0.04] text-white/55 hover:text-white'}`}>
                          {language === 'python' ? 'Python' : 'R'}
                        </button>
                      ))}
                    </div>
                    <CopyButton value={publicAiDrawingPrompts[promptLanguage]} label={`复制 ${promptLanguage === 'python' ? 'Python' : 'R'} 提示词`} />
                  </div>
                  <pre className="help-code-scroll max-h-[460px] overflow-auto whitespace-pre-wrap p-5 text-xs leading-6 text-[#dce9e5]"><code>{publicAiDrawingPrompts[promptLanguage]}</code></pre>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="scroll-mt-6 bg-[#f3f5f4] px-6 py-20 md:py-28">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-10 lg:grid-cols-[260px_minmax(0,1fr)]">
              <div>
                <div className="flex items-center gap-2 text-xs font-black uppercase text-[#167a65]"><HelpCircle className="h-4 w-4" /> 04 / Help & answers</div>
                <h2 className="mt-4 text-4xl font-black">按问题找到答案。</h2>
                <div className="mt-8 space-y-1">
                  <button type="button" onClick={() => setActiveCategory('all')} className={`help-category-button ${activeCategory === 'all' ? 'is-active' : ''}`}><BookOpen className="h-4 w-4" />全部问答<span>{helpFaqs.length}</span></button>
                  {(Object.keys(helpCategoryLabels) as HelpCategoryId[]).map((category) => {
                    const Icon = categoryIcons[category] ?? HelpCircle;
                    return <button key={category} type="button" onClick={() => setActiveCategory(category)} className={`help-category-button ${activeCategory === category ? 'is-active' : ''}`}><Icon className="h-4 w-4" />{helpCategoryLabels[category]}<span>{helpFaqs.filter((faq) => faq.category === category).length}</span></button>;
                  })}
                </div>
              </div>

              <div className="min-w-0">
                <div className="flex items-center justify-between gap-4 border-b border-[#10231f]/15 pb-4">
                  <div className="text-sm text-[#61706b]">找到 <strong className="text-[#10231f]">{filteredFaqs.length}</strong> 个相关问题</div>
                  <button type="button" onClick={toggleAll} disabled={filteredFaqs.length === 0} className="text-xs font-black text-[#167a65] disabled:opacity-40">{allVisibleOpen ? '收起全部' : '展开全部'}</button>
                </div>
                {filteredFaqs.length === 0 ? (
                  <div className="py-16 text-center"><Search className="mx-auto h-8 w-8 text-[#10231f]/20" /><p className="mt-4 text-sm text-[#61706b]">没有匹配的问题，试试更短的关键词。</p></div>
                ) : filteredFaqs.map((faq) => {
                  const open = openFaqs.has(faq.id);
                  return (
                    <article key={faq.id} className="border-b border-[#10231f]/15">
                      <button type="button" onClick={() => toggleFaq(faq.id)} className="group flex w-full items-start justify-between gap-5 py-6 text-left" aria-expanded={open}>
                        <span><span className="mb-2 block text-[10px] font-black uppercase text-[#a37828]">{helpCategoryLabels[faq.category]}</span><span className="text-base font-black leading-6 sm:text-lg">{faq.question}</span></span>
                        <span className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center border border-[#10231f]/20 transition ${open ? 'bg-[#10231f] text-white' : 'text-[#10231f] group-hover:border-[#167a65] group-hover:text-[#167a65]'}`}><ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} /></span>
                      </button>
                      <AnimatePresence initial={false}>
                        {open && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.24 }} className="overflow-hidden">
                            <div className="max-w-3xl pb-7 pr-10 text-sm leading-7 text-[#53645e]">
                              {Array.isArray(faq.answer) ? faq.answer.map((line) => <p key={line} className="mb-2 last:mb-0">{line}</p>) : <p>{faq.answer}</p>}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-[#dfe9e5] px-6 py-20">
          <div className="mx-auto flex max-w-7xl flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div><div className="text-xs font-black uppercase text-[#167a65]">Ready to work</div><h2 className="mt-4 max-w-3xl text-4xl font-black leading-tight md:text-5xl">用模板跑通第一张图，再在工作台里完成精修。</h2></div>
            <button type="button" onClick={start} className="group inline-flex shrink-0 items-center justify-center gap-2 bg-[#10231f] px-5 py-3 text-sm font-black text-white transition hover:bg-[#167a65]">{publicMode ? '免费注册并开始' : '创建新项目'}<ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" /></button>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#10231f]/10 bg-[#f3f5f4] px-6 py-7"><div className="mx-auto flex max-w-7xl flex-col gap-3 text-xs text-[#66746f] sm:flex-row sm:items-center sm:justify-between"><button type="button" onClick={() => onNavigate(publicMode ? 'landing' : 'home')} className="text-left font-black text-[#10231f]">SciFigure Studio</button><div>Python / R scientific figure help center</div></div></footer>

      <LandingAuthDialog open={authOpen} mode={authMode} onModeChange={setAuthMode} onClose={() => setAuthOpen(false)} onAuthenticated={() => { setAuthOpen(false); onAuthenticated?.(); }} />
    </div>
  );
}
