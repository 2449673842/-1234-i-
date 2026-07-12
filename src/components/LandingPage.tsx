import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowRight,
  Braces,
  Check,
  ChevronRight,
  DownloadCloud,
  DatabaseBackup,
  HardDrive,
  KeyRound,
  Layers3,
  LockKeyhole,
  MousePointer2,
  Palette,
  ServerCog,
  ShieldCheck,
  Table2,
} from 'lucide-react';
import type { ViewState } from '../App';
import { LandingAuthDialog, type LandingAuthMode } from './LandingAuthDialog';

interface LandingPageProps {
  onNavigate: (view: ViewState) => void;
  publicMode?: boolean;
  onAuthenticated?: () => void;
}

const workflow = [
  ['01', '导入', '上传 CSV / Excel 与 Python 或 R 绘图脚本。'],
  ['02', '识别', '保留真实 renderer 结果，并建立可编辑图元结构。'],
  ['03', '调整', '点选文本、坐标轴、图例、色条和子图进行精确修改。'],
  ['04', '投稿', '按真实尺寸预览，导出 SVG、PNG、PDF 或 TIFF。'],
];

const editingCapabilities = [
  {
    icon: MousePointer2,
    title: '点到哪里，修改哪里',
    text: '单个文本、整组刻度、图例容器和子图边框使用明确作用域，减少误改。',
  },
  {
    icon: Palette,
    title: '统一风格，不反复重跑',
    text: '字体、字号、颜色、线宽和图例样式可批量暂存，再一次性渲染。',
  },
  {
    icon: Layers3,
    title: '多 Figure 与多子图',
    text: '按代码实际输出管理 Figure，支持多面板布局、间距和绘图区尺寸。',
  },
  {
    icon: DownloadCloud,
    title: '按论文版面检查',
    text: '在 A4 与 Word 版心中查看真实插入尺寸、字体可读性和最终导出结果。',
  },
];

const dataProtectionCapabilities = [
  {
    icon: KeyRound,
    title: '传输过程加密',
    text: '正式服务通过加密连接传输登录信息、项目数据和导出文件，降低传输过程中的泄露风险。',
  },
  {
    icon: HardDrive,
    title: '服务器存储加密',
    text: '项目数据、绘图代码和导出资产存放在加密数据盘中，并由专用服务账号受控访问。',
  },
  {
    icon: DatabaseBackup,
    title: '备份独立加密',
    text: '备份在离开服务器前完成加密，并通过恢复校验确认备份不仅存在，而且能够真正恢复。',
  },
];

const serverProtectionCapabilities = [
  {
    icon: LockKeyhole,
    title: '账号与项目隔离',
    text: '每次访问都会核验登录身份和项目归属，一个账号不能读取或修改其他账号的项目资产。',
  },
  {
    icon: ServerCog,
    title: '绘图任务受限运行',
    text: 'Python / R 绘图任务在独立受限环境中运行，只获得本次任务所需的数据，不接触其他项目。',
  },
  {
    icon: ShieldCheck,
    title: '最小权限与访问记录',
    text: '服务组件只保留完成工作所需的权限，关键账号与管理操作受到限流、权限校验和审计记录保护。',
  },
];

interface RevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  key?: string;
}

function Reveal({ children, className = '', delay = 0 }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { threshold: 0.14 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-landing-reveal
      data-visible={visible ? 'true' : 'false'}
      className={`landing-v2-reveal ${className}`}
      style={{ '--landing-reveal-delay': `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}

export function LandingPage({ onNavigate, publicMode = false, onAuthenticated }: LandingPageProps) {
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<LandingAuthMode>('register');
  const pageRef = useRef<HTMLDivElement>(null);
  const heroMediaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const page = pageRef.current;
    const heroMedia = heroMediaRef.current;
    if (!page || !heroMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const updateParallax = () => {
      frame = 0;
      const offset = Math.min(page.scrollTop * 0.055, 46);
      heroMedia.style.setProperty('--landing-parallax-y', `${offset}px`);
    };
    const handleScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateParallax);
    };
    page.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      page.removeEventListener('scroll', handleScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const openAuth = (mode: LandingAuthMode) => {
    setAuthMode(mode);
    setAuthOpen(true);
  };

  const startPlatform = () => {
    if (publicMode) {
      openAuth('register');
      return;
    }
    onNavigate('project_create');
  };

  const openProjects = () => {
    if (publicMode) {
      openAuth('login');
      return;
    }
    onNavigate('projects');
  };

  return (
    <div ref={pageRef} className="landing-page flex-1 overflow-y-auto bg-[#f3f5f4] text-[#10231f] antialiased">
      <section className={`landing-v2-hero relative overflow-hidden bg-[#071411] text-white ${publicMode ? 'min-h-[92svh]' : 'min-h-[calc(92svh-56px)]'}`}>
        <div ref={heroMediaRef} className="landing-v2-hero-media absolute inset-0">
          <img
            src="/product-editor-preview.png"
            alt="SciFigure Studio 真实编辑器，画布中显示多子图，右侧为坐标轴属性编辑"
            className="landing-v2-hero-image h-full w-full object-cover object-[64%_center] opacity-60"
          />
        </div>
        <div className="absolute inset-0 bg-[#071411]/35" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(3,17,14,0.98)_0%,rgba(3,17,14,0.93)_36%,rgba(3,17,14,0.38)_70%,rgba(3,17,14,0.14)_100%)]" />

        {publicMode && (
          <header className="absolute inset-x-0 top-0 z-20 border-b border-white/10 bg-[#071411]/80 backdrop-blur-xl">
            <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-[#8de6d1] text-base font-black text-[#071411] sm:h-9 sm:w-9">S</div>
                <div className="whitespace-nowrap text-sm font-black text-white sm:text-base">SciFigure Studio</div>
              </div>
              <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                <button
                  type="button"
                  onClick={() => onNavigate('help')}
                  className="whitespace-nowrap px-2.5 py-2 text-xs font-bold text-white/75 transition hover:text-white sm:px-3 sm:text-sm"
                >
                  帮助中心
                </button>
                <button
                  type="button"
                  onClick={() => openAuth('login')}
                  className="whitespace-nowrap px-2.5 py-2 text-xs font-bold text-white/75 transition hover:text-white sm:px-3 sm:text-sm"
                >
                  登录
                </button>
                <button
                  type="button"
                  onClick={() => openAuth('register')}
                  className="whitespace-nowrap bg-[#8de6d1] px-3 py-2 text-xs font-black text-[#071411] transition hover:bg-white sm:px-4 sm:text-sm"
                >
                  免费注册
                </button>
              </div>
            </div>
          </header>
        )}

        <div className={`relative z-10 mx-auto flex max-w-7xl items-center px-6 ${publicMode ? 'min-h-[92svh] pb-20 pt-28' : 'min-h-[calc(92svh-56px)] py-16'}`}>
          <div className="landing-v2-hero-copy max-w-2xl">
            <div className="mb-6 flex items-center gap-3 text-xs font-bold uppercase text-[#a8d9cd]">
              <span className="h-px w-10 bg-[#8de6d1]" />
              Python / R · Figure editing workspace
            </div>
            <h1 className="text-4xl font-black leading-none text-white sm:text-5xl md:text-7xl">SciFigure Studio</h1>
            <div className="mt-5 max-w-2xl text-3xl font-black leading-tight text-white sm:text-4xl">
              论文 Figure 的可编辑工作台
            </div>
            <p className="mt-6 max-w-xl text-base leading-7 text-white/[0.72] md:text-lg md:leading-8">
              把真实 Python / R 绘图结果变成可点选、可批量统一、可追踪并可直接导出的科研 Figure。
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={startPlatform}
                className="group inline-flex items-center gap-2 bg-[#8de6d1] px-5 py-3 text-sm font-black text-[#071411] transition hover:bg-white"
              >
                {publicMode ? '免费注册并开始' : '创建新项目'}
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
              </button>
              <button
                type="button"
                onClick={openProjects}
                className="inline-flex items-center gap-2 border border-white/25 bg-black/10 px-5 py-3 text-sm font-bold text-white transition hover:border-white/55 hover:bg-white/10"
              >
                {publicMode ? '登录已有账号' : '打开已有项目'}
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-9 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-white/[0.62]">
              {['真实 renderer', '图元级编辑', 'Word / A4 预览', 'SVG · PNG · PDF · TIFF'].map(item => (
                <span key={item} className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-[#8de6d1]" />
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="absolute bottom-5 right-6 z-10 hidden border-l border-white/25 pl-4 text-xs leading-5 text-white/60 md:block">
          <div className="font-bold text-white">真实编辑器画面</div>
          <div>多子图画布与属性面板</div>
        </div>
      </section>

      <section className="border-b border-[#10231f]/12 bg-white">
        <div className="mx-auto grid max-w-7xl md:grid-cols-[1.15fr_2.85fr]">
          <Reveal className="border-b border-[#10231f]/12 px-6 py-10 md:border-b-0 md:border-r md:py-14">
            <div className="text-xs font-black uppercase text-[#167a65]">Working method</div>
            <h2 className="mt-3 text-3xl font-black leading-tight text-[#10231f]">真实代码进去，投稿级 Figure 出来</h2>
          </Reveal>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4">
            {workflow.map(([index, title, text], itemIndex) => (
              <Reveal key={title} delay={itemIndex * 85} className={`px-6 py-9 sm:py-12 ${itemIndex > 0 ? 'border-t border-[#10231f]/10 sm:border-l sm:border-t-0' : ''} ${itemIndex === 2 ? 'sm:border-l-0 lg:border-l' : ''}`}>
                <div className="text-xs font-black text-[#d1543f]">{index}</div>
                <h3 className="mt-5 text-lg font-black text-[#10231f]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#51605c]">{text}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:gap-20">
            <Reveal>
              <div className="text-xs font-black uppercase text-[#167a65]">Editing, not redrawing</div>
              <h2 className="mt-4 text-4xl font-black leading-tight text-[#10231f] md:text-5xl">不是重新画一张相似图，而是继续编辑原来的 Figure。</h2>
              <p className="mt-6 max-w-lg text-base leading-8 text-[#5e6d68]">
                SciFigure 保留脚本、Figure、图元、修改历史与导出结果之间的关系。用户修改的是明确对象，而不是一张无法复现的截图。
              </p>
            </Reveal>

            <div className="grid border-t border-[#10231f]/18 sm:grid-cols-2">
              {editingCapabilities.map((item, index) => {
                const Icon = item.icon;
                return (
                  <Reveal key={item.title} delay={index * 90} className={`group border-b border-[#10231f]/18 py-8 sm:px-7 ${index % 2 === 1 ? 'sm:border-l' : ''}`}>
                    <Icon className="h-6 w-6 text-[#167a65] transition-transform duration-300 group-hover:-translate-y-1" />
                    <h3 className="mt-7 text-lg font-black text-[#10231f]">{item.title}</h3>
                    <p className="mt-3 text-sm leading-7 text-[#5e6d68]">{item.text}</p>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[#0b211c] px-6 py-20 text-white md:py-28">
        <div className="mx-auto max-w-7xl">
          <Reveal className="grid gap-10 lg:grid-cols-[1fr_1fr] lg:items-end">
            <div>
              <div className="flex items-center gap-3 text-xs font-black uppercase text-[#8de6d1]">
                <ShieldCheck className="h-4 w-4" />
                Data protection
              </div>
              <h2 className="mt-5 max-w-2xl text-4xl font-black leading-tight md:text-5xl">你的数据如何被保护</h2>
            </div>
            <p className="max-w-xl text-sm leading-7 text-white/[0.62] lg:justify-self-end">
              从上传、存储、备份到绘图计算，平台采用分层保护。研究数据和绘图代码只在当前账号的项目范围内被处理。
            </p>
          </Reveal>

          <Reveal delay={90} className="landing-v2-security-flow mt-10" >
            {['加密传输', '加密存储', '加密备份', '受限计算'].map((item, index) => (
              <div key={item} className="landing-v2-security-flow__step">
                <span className="landing-v2-security-flow__dot" style={{ animationDelay: `${index * 360}ms` }} />
                <span>{item}</span>
              </div>
            ))}
          </Reveal>

          <div className="mt-14 grid border-y border-white/15 lg:grid-cols-2">
            <Reveal className="py-9 lg:pr-10">
              <div className="text-xs font-black uppercase text-[#e6c26b]">数据加密方案</div>
              <div className="mt-7">
                {dataProtectionCapabilities.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.title} className={`grid grid-cols-[auto_1fr] gap-5 py-6 ${index > 0 ? 'border-t border-white/12' : ''}`}>
                      <Icon className="mt-1 h-5 w-5 text-[#8de6d1]" />
                      <div>
                        <h3 className="text-lg font-black">{item.title}</h3>
                        <p className="mt-2 text-sm leading-7 text-white/[0.58]">{item.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Reveal>

            <Reveal delay={120} className="border-t border-white/15 py-9 lg:border-l lg:border-t-0 lg:pl-10">
              <div className="text-xs font-black uppercase text-[#e6c26b]">服务器安全保护</div>
              <div className="mt-7">
                {serverProtectionCapabilities.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.title} className={`grid grid-cols-[auto_1fr] gap-5 py-6 ${index > 0 ? 'border-t border-white/12' : ''}`}>
                      <Icon className="mt-1 h-5 w-5 text-[#8de6d1]" />
                      <div>
                        <h3 className="text-lg font-black">{item.title}</h3>
                        <p className="mt-2 text-sm leading-7 text-white/[0.58]">{item.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Reveal>
          </div>

          <Reveal delay={180} className="mt-8 flex items-start gap-3 border-l-2 border-[#d9a441] pl-4 text-xs leading-6 text-white/[0.58]">
            <Braces className="mt-1 h-4 w-4 shrink-0 text-[#e6c26b]" />
            <p>
              安全能力只有在正式服务器完成加密、备份恢复和部署验收后才允许上线。公开页面展示保护结果，不公开内部路径、配置、限制数值或防护规则细节。
            </p>
          </Reveal>
        </div>
      </section>

      <section className="bg-[#dfe9e5] px-6 py-20 md:py-24">
        <Reveal className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="flex items-center gap-3 text-xs font-black uppercase text-[#167a65]">
              <Table2 className="h-4 w-4" />
              Start with your real project
            </div>
            <h2 className="mt-4 max-w-3xl text-4xl font-black leading-tight text-[#10231f] md:text-5xl">从一份数据和一段脚本开始，把修改过程保留下来。</h2>
            <p className="mt-5 max-w-2xl text-sm leading-7 text-[#53645e]">
              免费注册后可进入项目工作区。已有账号可继续打开项目、编辑历史和导出资产。
            </p>
          </div>
          <div className="flex flex-wrap gap-3 lg:justify-end">
            <button
              type="button"
              onClick={startPlatform}
              className="group inline-flex items-center gap-2 bg-[#10231f] px-5 py-3 text-sm font-black text-white transition hover:bg-[#167a65]"
            >
              {publicMode ? '免费注册' : '创建项目'}
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
            </button>
            <button
              type="button"
              onClick={() => publicMode ? openAuth('login') : onNavigate('home')}
              className="inline-flex items-center gap-2 border border-[#10231f]/25 px-5 py-3 text-sm font-bold text-[#10231f] transition hover:border-[#10231f]"
            >
              {publicMode ? '登录账号' : '返回首页'}
            </button>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-[#10231f]/10 bg-[#f3f5f4] px-6 py-7">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 text-xs text-[#66746f] sm:flex-row sm:items-center sm:justify-between">
          <div className="font-black text-[#10231f]">SciFigure Studio</div>
          <div>Python / R scientific figure editing workspace</div>
        </div>
      </footer>

      <LandingAuthDialog
        open={authOpen}
        mode={authMode}
        onModeChange={setAuthMode}
        onClose={() => setAuthOpen(false)}
        onAuthenticated={() => {
          setAuthOpen(false);
          onAuthenticated?.();
        }}
      />
    </div>
  );
}
