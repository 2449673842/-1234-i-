import { useState } from 'react';
import { Settings, Blocks, Bell, Shield, User, CreditCard, Github, Globe, Cpu } from 'lucide-react';

export function SettingsPage({ subView }: { subView: string }) {
  const isIntegrations = subView === 'integrations';
  const [activeTab, setActiveTab] = useState('ai');

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2 mb-8">
          {isIntegrations ? <Blocks className="w-6 h-6 text-indigo-600" /> : <Settings className="w-6 h-6 text-slate-600" />} 
          {isIntegrations ? '账号与第三方集成' : '全局系统设置'}
        </h1>

        {isIntegrations ? (
          <div className="space-y-4">
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between hover:border-indigo-300 transition-colors">
                <div className="flex items-center gap-5">
                   <div className="w-12 h-12 bg-slate-900 text-white rounded-xl flex items-center justify-center shadow-inner">
                     <Github className="w-7 h-7" />
                   </div>
                   <div>
                     <h3 className="font-bold text-slate-800 text-lg">GitHub 集成</h3>
                     <p className="text-sm text-slate-500 mt-0.5">将生成的 Python 代码和 Figure Spec 自动推送到 GitHub 仓库以建立可复现工作流。</p>
                   </div>
                </div>
                <button className="px-5 py-2 bg-slate-100 text-slate-700 font-medium text-sm rounded-lg hover:bg-slate-200 transition-colors shrink-0">连接</button>
             </div>
             
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between hover:border-blue-300 transition-colors">
                <div className="flex items-center gap-5">
                   <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-xl flex items-center justify-center shadow-inner">
                     <Globe className="w-7 h-7" />
                   </div>
                   <div>
                     <h3 className="font-bold text-slate-800 text-lg">OpenScience 数据集仓库</h3>
                     <p className="text-sm text-slate-500 mt-0.5">直接从公共环境科学与生物信息学数据存储库导入结构化数据用于可视化。</p>
                   </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="flex items-center gap-1.5 text-emerald-600 text-sm font-medium"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> 已连接</span>
                  <button className="px-4 py-2 bg-white border border-slate-200 text-slate-700 font-medium text-sm rounded-lg hover:bg-slate-50 transition-colors">配置</button>
                </div>
             </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex overflow-hidden min-h-[600px]">
            <div className="w-64 bg-slate-50/50 border-r border-slate-200 p-4 space-y-1.5 shrink-0">
               <button onClick={() => setActiveTab('ai')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'ai' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}><Cpu className="w-4 h-4"/> AI 大模型配置</button>
               <button onClick={() => setActiveTab('profile')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'profile' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}><User className="w-4 h-4"/> 个人资料</button>
               <button className="w-full flex items-center gap-3 px-3 py-2.5 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"><CreditCard className="w-4 h-4"/> 订阅与账单</button>
               <div className="my-2 border-t border-slate-200/60 mx-2"></div>
               <button className="w-full flex items-center gap-3 px-3 py-2.5 text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium transition-colors">退出登录</button>
            </div>
            
            <div className="flex-1 p-8 space-y-8">
                {activeTab === 'ai' && (
                  <div>
                    <h2 className="text-xl font-bold text-slate-800 mb-1">AI 辅助工作流</h2>
                    <p className="text-sm text-slate-500 mb-6">本工具采用「拷贝提示词 → 网页 AI 改写 → 粘贴回来」的协议模式，无需配置 API Key。</p>

                    <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 max-w-2xl">
                      <h3 className="font-semibold text-blue-800 mb-3">使用流程</h3>
                      <ol className="space-y-3 text-sm text-blue-700">
                        <li className="flex gap-3"><span className="font-bold shrink-0">1.</span> 在<strong>数据导入页</strong>选择「自定义脚本」，粘贴你的 Matplotlib 代码</li>
                        <li className="flex gap-3"><span className="font-bold shrink-0">2.</span> 点击 <strong>「复制提示词 + 脚本」</strong>，系统会自动生成一段标准提示词</li>
                        <li className="flex gap-3"><span className="font-bold shrink-0">3.</span> 打开任意网页 AI（ChatGPT / DeepSeek / Gemini），粘贴进去</li>
                        <li className="flex gap-3"><span className="font-bold shrink-0">4.</span> AI 返回改写后的代码，复制回来粘贴到下方输入框</li>
                        <li className="flex gap-3"><span className="font-bold shrink-0">5.</span> 点击 <strong>「应用 AI 结果并打开编辑器」</strong></li>
                      </ol>
                      <p className="mt-4 text-xs text-blue-500">提示词中自动包含数据集列名和你的原始脚本，无需手动修改。</p>
                    </div>
                  </div>
                )}

               {activeTab === 'profile' && (
                 <div>
                   <h2 className="text-xl font-bold text-slate-800 mb-1">个人资料</h2>
                   <p className="text-sm text-slate-500 mb-6">管理您的个人信息、头像和机构归属。</p>
                   
                   <div className="flex items-center gap-6 mb-8 bg-slate-50 p-6 rounded-xl border border-slate-100">
                     <div className="w-24 h-24 rounded-full bg-slate-200 border-4 border-white shadow-md overflow-hidden shrink-0">
                        <img src="https://i.pravatar.cc/150?img=33" alt="Avatar" className="w-full h-full object-cover" />
                     </div>
                     <div>
                       <button className="px-4 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors shadow-sm mb-2">更改头像</button>
                       <p className="text-xs text-slate-500">支持 JPG, PNG. 最大尺寸 2MB.</p>
                     </div>
                   </div>
                 </div>
               )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
