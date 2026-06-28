import {
  ArrowRight,
  Braces,
  Check,
  ChevronRight,
  DownloadCloud,
  FileCode2,
  Layers3,
  MousePointer2,
  Palette,
  Play,
  ShieldCheck,
  Sparkles,
  Table2,
  Wand2,
} from 'lucide-react';
import { ViewState } from '../App';

interface LandingPageProps {
  onNavigate: (view: ViewState) => void;
}

const workflow = [
  {
    icon: Table2,
    title: '上传数据',
    text: 'CSV / Excel 进入项目沙箱，字段、表头和多文件关系先被平台记录。',
  },
  {
    icon: Braces,
    title: '导入脚本',
    text: '运行真实 Matplotlib 脚本，不把图重画成前端假预览。',
  },
  {
    icon: MousePointer2,
    title: '点选图元',
    text: '标题、坐标轴、图例、线、点、误差棒进入可编辑对象模型。',
  },
  {
    icon: DownloadCloud,
    title: '导出复现',
    text: '输出 SVG / PNG 和可复现信息，保留脚本、数据指纹与编辑记录。',
  },
];

const capabilities = [
  ['真实 Python 渲染', '保留 Matplotlib 结果，不用前端手写图骗用户。'],
  ['Manifest 图元识别', '把标题、坐标轴、图例、点线面变成右侧可操作参数。'],
  ['字体/配色中心', '批量统一标题、坐标、刻度、分组颜色和论文风格。'],
  ['组合图工作台', '选择 2/4/6 张导出图，拖动排版，统一标签和内部字体。'],
  ['错误诊断日志', '记录上传文件、表头、转译代码和真实报错，方便 AI/人工排查。'],
  ['本地优先', '数据先留在本机项目库，适合还没准备上云的科研数据处理。'],
];

const values = [
  {
    before: 'AI 生成代码后，一改字体就回 Python 里盲调。',
    after: '在画布里直接选标题、刻度、图例和线条，右侧改参数。',
  },
  {
    before: '换电脑、换文件名、本地路径失效，脚本立刻崩。',
    after: '项目文件统一管理，脚本通过平台注入的数据映射读取。',
  },
  {
    before: '拼 4 张图要写 GridSpec，改间距反复试几十次。',
    after: '导出图进入组合工作台，拖动、交换、统一字体后再导出。',
  },
];

const codeLines = [
  'df = load_data()',
  'fig, ax = plt.subplots()',
  'ax.errorbar(x, y, yerr=se)',
  'ax.set_xlabel("Treatment time")',
  'build_figure(df)',
];

function MiniFigure() {
  return (
    <div className="relative h-full min-h-[360px] overflow-hidden rounded-[2rem] border border-white/20 bg-white/10 shadow-2xl shadow-slate-950/30 backdrop-blur-2xl">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(56,189,248,0.22),transparent_28%),radial-gradient(circle_at_88%_20%,rgba(245,158,11,0.24),transparent_24%),linear-gradient(135deg,rgba(255,255,255,0.16),rgba(255,255,255,0.04))]" />
      <div className="absolute left-5 top-5 right-5 flex items-center justify-between rounded-2xl border border-white/15 bg-slate-950/35 px-4 py-3 backdrop-blur-xl">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-200/80">live figure session</div>
          <div className="text-sm font-semibold text-white">Matplotlib SVG introspection</div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.8)]" />
          <span className="text-xs text-emerald-100">ready</span>
        </div>
      </div>

      <div className="absolute left-7 top-24 w-[42%] rounded-2xl border border-white/15 bg-slate-950/55 p-4 font-mono text-[11px] leading-6 text-slate-200 shadow-xl backdrop-blur-xl">
        {codeLines.map((line, index) => (
          <div key={line} className="landing-code-line" style={{ animationDelay: `${index * 160}ms` }}>
            <span className="mr-3 text-slate-500">{index + 1}</span>
            <span className={index === 2 ? 'text-amber-200' : index === 3 ? 'text-cyan-200' : ''}>{line}</span>
          </div>
        ))}
      </div>

      <div className="absolute bottom-8 right-7 w-[58%] rounded-[1.5rem] border border-white/20 bg-white/92 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">selected object</div>
            <div className="text-sm font-black text-slate-900">Y Axis Label · font 12 pt</div>
          </div>
          <div className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-700">editable</div>
        </div>
        <svg viewBox="0 0 360 210" className="h-52 w-full overflow-visible">
          <defs>
            <linearGradient id="landingLine" x1="0" x2="1">
              <stop offset="0%" stopColor="#0ea5e9" />
              <stop offset="100%" stopColor="#f97316" />
            </linearGradient>
          </defs>
          <rect x="42" y="18" width="280" height="156" fill="#fff" stroke="#e2e8f0" />
          <line x1="42" y1="174" x2="322" y2="174" stroke="#0f172a" strokeWidth="2" />
          <line x1="42" y1="18" x2="42" y2="174" stroke="#0f172a" strokeWidth="2" />
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line x1={70 + i * 52} y1="174" x2={70 + i * 52} y2="178" stroke="#0f172a" />
              <text x={63 + i * 52} y="196" fill="#111827" fontSize="12">{i * 24}h</text>
            </g>
          ))}
          <polyline
            points="58,142 90,122 126,132 168,88 208,100 248,64 302,46"
            fill="none"
            stroke="url(#landingLine)"
            strokeWidth="4"
            strokeLinecap="round"
            className="landing-draw-line"
          />
          {[58, 90, 126, 168, 208, 248, 302].map((x, i) => {
            const y = [142, 122, 132, 88, 100, 64, 46][i];
            return <circle key={x} cx={x} cy={y} r="5.5" fill={i < 3 ? '#0ea5e9' : '#f97316'} stroke="#fff" strokeWidth="2" />;
          })}
          <text x="168" y="16" fill="#0f172a" fontSize="15" fontWeight="700">N2O response over time</text>
          <text x="148" y="207" fill="#0f172a" fontSize="14" fontWeight="700">Treatment time</text>
          <g className="landing-selection-box">
            <rect x="4" y="68" width="25" height="92" rx="4" fill="none" stroke="#2563eb" strokeWidth="2" strokeDasharray="5 4" />
            <circle cx="4" cy="68" r="3.5" fill="#2563eb" />
            <circle cx="29" cy="160" r="3.5" fill="#2563eb" />
            <text x="18" y="151" transform="rotate(-90 18 151)" fill="#0f172a" fontSize="14" fontWeight="700">LnRR</text>
          </g>
        </svg>
      </div>

      <div className="absolute bottom-7 left-8 rounded-2xl border border-white/20 bg-white/12 px-4 py-3 text-white shadow-xl backdrop-blur-xl landing-float">
        <div className="text-[11px] uppercase tracking-[0.22em] text-white/55">patch log</div>
        <div className="mt-1 text-sm font-semibold">fontsize → 12 · color → #111827</div>
      </div>
    </div>
  );
}

function RuntimePipelineGraphic() {
  const nodes = [
    { label: 'CSV / Excel', sub: '字段与表头', x: 56, y: 90 },
    { label: 'Python Script', sub: '真实 Matplotlib', x: 246, y: 90 },
    { label: 'Artist Tree', sub: '运行时内省', x: 444, y: 90 },
    { label: 'Manifest', sub: '可编辑对象', x: 636, y: 90 },
    { label: 'SVG + Export', sub: '论文输出', x: 828, y: 90 },
  ];

  return (
    <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#09131f]/90 p-5 shadow-2xl shadow-black/20 backdrop-blur-2xl">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_0%,rgba(14,165,233,0.22),transparent_35%),radial-gradient(circle_at_80%_80%,rgba(251,191,36,0.13),transparent_30%)]" />
      <div className="relative mb-4 flex items-center justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.25em] text-cyan-200/75">runtime map</div>
          <h3 className="mt-1 text-xl font-black text-white">不是翻译图片，是解析活的 Matplotlib 对象树</h3>
        </div>
        <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-xs font-bold text-emerald-200">deterministic replay</div>
      </div>
      <svg viewBox="0 0 980 220" className="relative h-[240px] w-full overflow-visible">
        <defs>
          <linearGradient id="pipelineStroke" x1="0" x2="1">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="55%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#fbbf24" />
          </linearGradient>
          <filter id="pipelineGlow">
            <feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          d="M150 110 C220 40 270 180 342 110 S500 40 548 110 S700 182 740 110 S860 42 910 110"
          fill="none"
          stroke="url(#pipelineStroke)"
          strokeWidth="3"
          strokeLinecap="round"
          className="landing-pipeline-path"
        />
        <circle r="7" fill="#fff" filter="url(#pipelineGlow)" className="landing-pipeline-dot">
          <animateMotion dur="5.2s" repeatCount="indefinite" path="M150 110 C220 40 270 180 342 110 S500 40 548 110 S700 182 740 110 S860 42 910 110" />
        </circle>
        {nodes.map((node, index) => (
          <g key={node.label} className="landing-pipeline-node" style={{ animationDelay: `${index * 120}ms` }}>
            <rect x={node.x} y={node.y - 44} width="136" height="88" rx="18" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.16)" />
            <text x={node.x + 68} y={node.y - 5} textAnchor="middle" fill="#fff" fontSize="16" fontWeight="800">{node.label}</text>
            <text x={node.x + 68} y={node.y + 20} textAnchor="middle" fill="#94a3b8" fontSize="12">{node.sub}</text>
          </g>
        ))}
        {[205, 395, 591, 783].map((x) => (
          <text key={x} x={x} y="178" textAnchor="middle" fill="#67e8f9" fontSize="12" fontWeight="800">replay</text>
        ))}
      </svg>
    </div>
  );
}

function EditingShowcaseGraphic() {
  const palette = ['#1f78b4', '#d62728', '#2ca02c', '#ffbf00'];
  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-black/20 backdrop-blur-xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.25em] text-amber-200/75">before / after</div>
            <h3 className="mt-1 text-xl font-black text-white">把“改代码盲调”变成画布操作</h3>
          </div>
          <div className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white">Origin-like selection</div>
        </div>
        <div className="relative h-[330px] overflow-hidden rounded-[1.5rem] bg-slate-950/50">
          <div className="absolute inset-y-0 left-0 w-1/2 border-r border-white/10 p-5">
            <div className="mb-3 text-xs font-black uppercase tracking-[0.2em] text-red-200/75">before</div>
            <div className="rounded-2xl border border-red-200/10 bg-red-500/10 p-4 font-mono text-[11px] leading-6 text-red-50/80">
              <div>ax.set_ylabel(...)</div>
              <div>ax.tick_params(...)</div>
              <div>fig.tight_layout(...)</div>
              <div className="landing-code-warning mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-red-100">反复重跑，靠肉眼猜</div>
            </div>
          </div>
          <div className="absolute inset-y-0 right-0 w-1/2 p-5">
            <div className="mb-3 text-xs font-black uppercase tracking-[0.2em] text-emerald-200/75">after</div>
            <svg viewBox="0 0 320 230" className="h-[245px] w-full rounded-2xl bg-white">
              <rect x="56" y="28" width="218" height="148" fill="#fff" stroke="#cbd5e1" />
              <line x1="56" y1="176" x2="274" y2="176" stroke="#111827" strokeWidth="2" />
              <line x1="56" y1="28" x2="56" y2="176" stroke="#111827" strokeWidth="2" />
              {palette.map((color, i) => (
                <g key={color}>
                  <circle cx={88 + i * 46} cy={132 - i * 18} r="7" fill={color} className="landing-pop-dot" style={{ animationDelay: `${i * 180}ms` }} />
                  <line x1={88 + i * 46} y1={132 - i * 18} x2={88 + i * 46} y2={150 - i * 13} stroke={color} strokeWidth="2" />
                </g>
              ))}
              <text x="122" y="216" fill="#111827" fontSize="15" fontWeight="800">Time point</text>
              <g className="landing-selection-box">
                <rect x="12" y="78" width="28" height="72" rx="5" fill="none" stroke="#2563eb" strokeWidth="2" strokeDasharray="5 4" />
                <text x="30" y="145" transform="rotate(-90 30 145)" fill="#111827" fontSize="15" fontWeight="800">LnRR</text>
              </g>
              <g className="landing-cursor">
                <path d="M238 54 L258 102 L244 97 L236 116 L227 112 L235 94 L222 98 Z" fill="#0f172a" stroke="#fff" strokeWidth="2" />
              </g>
            </svg>
          </div>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-black/20 backdrop-blur-xl">
        <div className="mb-5">
          <div className="text-xs font-bold uppercase tracking-[0.25em] text-cyan-200/75">composer</div>
          <h3 className="mt-1 text-xl font-black text-white">组合图也能统一风格</h3>
          <p className="mt-2 text-sm leading-6 text-slate-400">选择多张导出图，统一标签、尺寸、内部字体，再拖动交换位置。</p>
        </div>
        <div className="relative h-[330px] rounded-[1.5rem] border border-white/10 bg-slate-950/45 p-4">
          {[0, 1, 2, 3].map((i) => {
            const left = i % 2 === 0 ? 26 : 190;
            const top = i < 2 ? 44 : 184;
            return (
              <div
                key={i}
                className="landing-composer-panel absolute rounded-xl border border-white/15 bg-white shadow-xl"
                style={{ left, top, width: 128, height: 92, animationDelay: `${i * 160}ms` }}
              >
                <div className="absolute -top-6 left-0 text-sm font-black text-white">({String.fromCharCode(97 + i)})</div>
                <svg viewBox="0 0 128 92" className="h-full w-full">
                  <line x1="18" y1="72" x2="112" y2="72" stroke="#111827" />
                  <line x1="18" y1="18" x2="18" y2="72" stroke="#111827" />
                  <polyline points={`22,${62 - i * 3} 44,${48 + i * 2} 68,${54 - i * 4} 92,${30 + i * 3}`} fill="none" stroke={palette[i]} strokeWidth="3" />
                  <text x="42" y="86" fontSize="7" fill="#111827">uniform font</text>
                </svg>
              </div>
            );
          })}
          <div className="absolute bottom-4 left-4 right-4 rounded-2xl border border-cyan-200/20 bg-cyan-300/10 px-4 py-3 backdrop-blur-xl">
            <div className="flex items-center justify-between text-xs font-bold text-cyan-100">
              <span>统一字体：Times New Roman · 10pt</span>
              <span>SVG / PNG</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage({ onNavigate }: LandingPageProps) {
  return (
    <div className="landing-page flex-1 overflow-y-auto bg-[#071018] text-white antialiased">
      <section className="relative min-h-[calc(100svh-56px)] overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(14,165,233,0.32),transparent_32%),radial-gradient(circle_at_78%_8%,rgba(245,158,11,0.24),transparent_28%),linear-gradient(145deg,#071018_0%,#0f172a_45%,#111827_100%)]" />
        <div className="absolute inset-0 opacity-[0.16] [background-image:linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="landing-orb left-[8%] top-[18%]" />
        <div className="landing-orb landing-orb-alt right-[10%] top-[8%]" />

        <div className="relative mx-auto grid min-h-[calc(100svh-56px)] max-w-7xl items-center gap-10 px-6 py-16 lg:grid-cols-[0.92fr_1.08fr]">
          <div className="max-w-2xl">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold text-cyan-100 shadow-lg backdrop-blur-xl">
              <Sparkles className="h-4 w-4 text-amber-200" />
              Python 科研图 · 可视化微调 · 组合导出
            </div>
            <h1 className="text-5xl font-black leading-[0.98] tracking-[-0.055em] text-white md:text-7xl">
              把 AI 生成的科研绘图代码，
              <span className="block bg-gradient-to-r from-cyan-200 via-white to-amber-200 bg-clip-text text-transparent">
                变成可编辑画布。
              </span>
            </h1>
            <p className="mt-7 max-w-xl text-base leading-8 text-slate-300 md:text-lg">
              SciFigure 面向论文作图：上传数据和 Matplotlib 脚本，平台真实渲染图像，识别图元，再用类似 Origin 的方式调整字体、颜色、坐标轴、线和组合图。
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onNavigate('project_create')}
                className="group inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-black text-slate-950 shadow-2xl shadow-cyan-950/30 transition hover:-translate-y-0.5 hover:bg-cyan-50"
              >
                从数据和脚本开始
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('projects')}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-6 py-3 text-sm font-bold text-white backdrop-blur-xl transition hover:bg-white/15"
              >
                打开已有项目
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t border-white/10 pt-6">
              {[
                ['真实渲染', 'Python Matplotlib'],
                ['交互编辑', '字体/配色/坐标'],
                ['论文输出', 'SVG/PNG/复现包'],
              ].map(([title, text]) => (
                <div key={title}>
                  <div className="text-sm font-black text-white">{title}</div>
                  <div className="mt-1 text-[11px] leading-4 text-slate-400">{text}</div>
                </div>
              ))}
            </div>
          </div>

          <MiniFigure />
        </div>
      </section>

      <section className="relative border-y border-white/10 bg-white/[0.03] px-6 py-16">
        <div className="mx-auto max-w-7xl">
          <div className="mb-10 flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.28em] text-cyan-200/80">workflow</div>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-white md:text-5xl">别人一眼能看懂的工作流</h2>
            </div>
            <p className="max-w-md text-sm leading-7 text-slate-400">
              不是模板图库，也不是截图标注工具。它的主线是：真实数据 + 真实脚本 + 可编辑图元 + 可复现导出。
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            {workflow.map((step, index) => {
              const Icon = step.icon;
              return (
                <div key={step.title} className="group relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/[0.06] p-5 backdrop-blur-xl transition hover:-translate-y-1 hover:bg-white/[0.09]">
                  <div className="absolute right-4 top-4 text-5xl font-black text-white/[0.04]">0{index + 1}</div>
                  <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-cyan-100">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="text-base font-black text-white">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-400">{step.text}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-8">
            <RuntimePipelineGraphic />
          </div>
        </div>
      </section>

      <section className="relative px-6 py-20">
        <div className="mx-auto max-w-7xl">
          <div className="mb-10 max-w-3xl">
            <div className="text-xs font-bold uppercase tracking-[0.28em] text-cyan-200/80">interactive proof</div>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-white md:text-5xl">用动态演示说明“能改什么”</h2>
            <p className="mt-5 text-sm leading-7 text-slate-400">
              页面不只讲概念，而是直接展示：代码变对象、对象可选中、参数可统一、导出图可组合。
            </p>
          </div>
          <EditingShowcaseGraphic />
        </div>
      </section>

      <section className="relative overflow-hidden px-6 py-20">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(14,165,233,0.12),transparent_35%)]" />
        <div className="relative mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="lg:sticky lg:top-20 lg:h-fit">
            <div className="text-xs font-bold uppercase tracking-[0.28em] text-amber-200/80">why it matters</div>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-white md:text-5xl">解决科研作图最浪费时间的三件事</h2>
            <p className="mt-5 text-sm leading-7 text-slate-400">
              平台价值不在“自动生成一张看起来像图的图片”，而是把 Python 图变成可持续修改、可追踪、可导出的科研资产。
            </p>
          </div>

          <div className="space-y-5">
            {values.map((item, index) => (
              <div key={item.before} className="rounded-[1.5rem] border border-white/10 bg-white/[0.07] p-5 shadow-2xl shadow-black/10 backdrop-blur-xl">
                <div className="mb-4 inline-flex rounded-full bg-white/10 px-3 py-1 text-xs font-black text-white">问题 {index + 1}</div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-red-300/15 bg-red-500/10 p-4">
                    <div className="text-xs font-bold uppercase tracking-[0.2em] text-red-200/80">before</div>
                    <p className="mt-2 text-sm leading-6 text-red-50/85">{item.before}</p>
                  </div>
                  <div className="rounded-2xl border border-emerald-300/15 bg-emerald-500/10 p-4">
                    <div className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-200/80">after</div>
                    <p className="mt-2 text-sm leading-6 text-emerald-50/90">{item.after}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 pb-20">
        <div className="mx-auto max-w-7xl rounded-[2rem] border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-black/20 backdrop-blur-2xl md:p-8">
          <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.28em] text-cyan-200/80">capabilities</div>
              <h2 className="mt-3 text-3xl font-black text-white">能提供什么价值</h2>
            </div>
            <div className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-xs font-bold text-slate-300">
              适合：论文重绘、AI 代码转平台、批量风格统一、组合图排版
            </div>
          </div>

          <div className="grid gap-px overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/10 md:grid-cols-3">
            {capabilities.map(([title, text], index) => {
              const icons = [ShieldCheck, Wand2, Palette, Layers3, FileCode2, DownloadCloud];
              const Icon = icons[index];
              return (
                <div key={title} className="group bg-[#101a25]/95 p-6 transition hover:bg-[#142131]">
                  <Icon className="mb-8 h-6 w-6 text-cyan-200 transition group-hover:scale-110" />
                  <h3 className="text-base font-black text-white">{title}</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-400">{text}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-white/12 bg-gradient-to-br from-white/[0.13] to-white/[0.04] p-8 text-center shadow-2xl shadow-cyan-950/20 backdrop-blur-2xl md:p-12">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-white/10">
            <Play className="h-6 w-6 fill-white text-white" />
          </div>
          <h2 className="text-3xl font-black tracking-tight text-white md:text-5xl">从一份真实 CSV 和一段 Python 脚本开始</h2>
          <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-slate-300">
            早期专业版建议以 ¥10/月做可验证付费入口：核心卖点不是“AI 画图”，而是让 AI 给出的代码能进入平台、能调图、能导出、能复现。
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => onNavigate('project_create')}
              className="inline-flex items-center gap-2 rounded-full bg-cyan-200 px-6 py-3 text-sm font-black text-slate-950 transition hover:-translate-y-0.5 hover:bg-white"
            >
              新建项目
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('home')}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-6 py-3 text-sm font-bold text-white transition hover:bg-white/15"
            >
              返回首页
            </button>
          </div>
          <div className="mt-8 flex flex-wrap justify-center gap-3 text-xs text-slate-400">
            {['本地项目库', '真实 Matplotlib 渲染', '图元参数编辑', '组合图排版', '导出记录管理'].map((item) => (
              <span key={item} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
                <Check className="h-3.5 w-3.5 text-emerald-300" />
                {item}
              </span>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
