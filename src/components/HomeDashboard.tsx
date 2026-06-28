import { ArrowRight, FilePlus2, FolderOpen, Info } from 'lucide-react';
import { ViewState } from '../App';

export function HomeDashboard({ onNavigate }: { onNavigate: (view: ViewState, subView?: string) => void }) {
  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
      <div className="max-w-5xl mx-auto space-y-8">
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-8 py-10 border-b border-slate-100 bg-gradient-to-br from-slate-50 via-white to-blue-50">
            <div className="max-w-2xl space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                <Info className="w-3.5 h-3.5" />
                本地科研绘图工具
              </div>
              <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
                从真实数据开始，不展示伪统计和伪项目。
              </h1>
              <p className="text-sm leading-6 text-slate-600">
                当前版本只保留可执行的本地工作流入口。新项目先上传主数据并确认字段，再准备 Python 脚本；已有项目从本地数据库打开，不再展示样板活动、虚构协作者或占位模板。
              </p>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-0">
            <button
              onClick={() => onNavigate('project_create')}
              className="text-left p-8 border-b md:border-b-0 md:border-r border-slate-100 hover:bg-slate-50 transition-colors"
            >
              <div className="w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center mb-5 shadow-sm">
                <FilePlus2 className="w-6 h-6" />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 mb-2">新建项目</h2>
                  <p className="text-sm text-slate-600 leading-6">
                    先上传主数据并确认字段，再准备 Python 脚本，最后渲染多 Figure 结果。
                  </p>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-400 shrink-0" />
              </div>
            </button>

            <button
              onClick={() => onNavigate('projects', 'my_projects')}
              className="text-left p-8 hover:bg-slate-50 transition-colors"
            >
              <div className="w-12 h-12 rounded-xl bg-slate-900 text-white flex items-center justify-center mb-5 shadow-sm">
                <FolderOpen className="w-6 h-6" />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 mb-2">打开已有项目</h2>
                  <p className="text-sm text-slate-600 leading-6">
                    从本地 SQLite 项目库里打开、继续编辑或检查之前保存的 figure spec。
                  </p>
                </div>
                <ArrowRight className="w-5 h-5 text-slate-400 shrink-0" />
              </div>
            </button>
          </div>
        </section>

        {/* Pro Banner */}
        <div 
          onClick={() => onNavigate('landing')}
          className="bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-indigo-500/10 border border-amber-200/60 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-6 cursor-pointer hover:border-amber-300 transition-all shadow-sm group"
        >
          <div className="space-y-1 text-center md:text-left">
            <h3 className="text-base font-bold text-amber-800 flex items-center justify-center md:justify-start gap-1.5">
              <span>★</span> SciFigure Studio Pro 专业版已发布
            </h3>
            <p className="text-xs text-amber-700/80 leading-relaxed max-w-2xl">
              解决 AI 绘图代码报错、图元微调困难、拼图布局复杂的问题。支持真 SVG 直选编辑、配色中心和高 DPI 导出，早期专业版按 <span className="font-bold text-amber-900">¥10 / 月</span> 规划验证。
            </p>
          </div>
          <span className="shrink-0 px-4 py-2 bg-amber-600 text-white font-semibold text-xs rounded-xl shadow-md group-hover:bg-amber-700 transition-colors flex items-center gap-1">
            了解详情并订阅
            <ArrowRight className="w-3.5 h-3.5 animate-bounce-horizontal" />
          </span>
        </div>

        <section className="grid md:grid-cols-3 gap-4">
          {[
            ['数据入口', '唯一推荐入口是“导入数据”，避免模板页和样板文件分散注意力。'],
            ['状态说明', '项目、数据源和渲染结果都以本地状态为准，不再展示虚构指标。'],
            ['当前限制', '模板库和外部资源库未接入真实内容前，不应继续作为主入口暴露。'],
          ].map(([title, description]) => (
            <div key={title} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-900 mb-2">{title}</h3>
              <p className="text-sm text-slate-600 leading-6">{description}</p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
