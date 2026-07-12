import { ArrowRight, FilePlus2, FolderOpen, Grid, ShieldCheck, Braces, Ruler } from 'lucide-react';
import { ViewState } from '../App';

export function HomeDashboard({ onNavigate }: { onNavigate: (view: ViewState, subView?: string) => void }) {
  return (
    <main className="scifig-home flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
      <div className="max-w-6xl mx-auto space-y-7">
        <section className="scifig-home-intro overflow-hidden">
          <div className="px-6 py-8 sm:px-9 sm:py-10">
            <div className="max-w-3xl">
              <div className="mb-4 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-700">
                <span className="h-px w-8 bg-emerald-500" />
                Figure workspace
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold text-[#10231f]">继续你的科研 Figure 工作流</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                从真实数据与 Python / R 脚本开始，保留可追溯的修改记录，并在投稿尺寸下完成图元调整与导出。
              </p>
            </div>
          </div>

          <div className="grid md:grid-cols-3 border-t border-slate-200/80 bg-white/85">
            <button
              onClick={() => onNavigate('project_create')}
              className="scifig-home-action"
            >
              <div className="scifig-home-action-icon is-primary">
                <FilePlus2 className="w-5 h-5" />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 mb-1.5">新建项目</h2>
                  <p className="text-sm text-slate-600 leading-6">
                    导入数据与脚本，建立新的可编辑 Figure 项目。
                  </p>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-400 shrink-0" />
              </div>
            </button>

            <button
              onClick={() => onNavigate('projects', 'my_projects')}
              className="scifig-home-action"
            >
              <div className="scifig-home-action-icon">
                <FolderOpen className="w-5 h-5" />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 mb-1.5">打开已有项目</h2>
                  <p className="text-sm text-slate-600 leading-6">
                    继续上次保存的图元、代码与导出版本。
                  </p>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-400 shrink-0" />
              </div>
            </button>

            <button
              onClick={() => onNavigate('composer')}
              className="scifig-home-action"
            >
              <div className="scifig-home-action-icon is-compose">
                <Grid className="w-5 h-5" />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 mb-1.5">组合图工作台</h2>
                  <p className="text-sm text-slate-600 leading-6">
                    汇集多个 Figure，生成统一绘图区尺寸的组合代码项目。
                  </p>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-400 shrink-0" />
              </div>
            </button>
          </div>
        </section>

        <section className="grid md:grid-cols-3 border-y border-slate-200 bg-white/60">
          {[
            [Braces, '双引擎', 'Python 与 R 使用统一前端协议，保留各自可靠的渲染路径。'],
            [Ruler, '投稿尺寸', '按单栏、双栏与 Word 版心检查实际尺寸和字体可读性。'],
            [ShieldCheck, '数据边界', '项目归属校验与受限渲染共同保护用户内容。'],
          ].map(([Icon, title, description]) => (
            <div key={title as string} className="flex gap-3 px-5 py-5 md:border-r md:last:border-r-0 border-slate-200">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
              <div>
                <h3 className="text-xs font-semibold text-slate-900">{title as string}</h3>
                <p className="mt-1 text-xs text-slate-500 leading-5">{description as string}</p>
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
