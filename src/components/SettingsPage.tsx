import { useEffect, useState } from 'react';
import { Blocks, CheckCircle2, Cpu, CreditCard, KeyRound, LogOut, Settings, Shield, User } from 'lucide-react';

const TOKEN_KEY = 'scifigure:auth-token';
const DEVICE_KEY = 'scifigure:device-fingerprint';

interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

interface LicenseState {
  plan: string;
  status: 'free' | 'pro' | 'expired';
  source: string;
  endsAt: string | null;
  isPro: boolean;
}

interface AuthState {
  user: AuthUser | null;
  license: LicenseState;
  deviceCount?: number;
}

function getDeviceFingerprint() {
  let fingerprint = window.localStorage.getItem(DEVICE_KEY);
  if (!fingerprint) {
    fingerprint = `web_${crypto.randomUUID()}`;
    window.localStorage.setItem(DEVICE_KEY, fingerprint);
  }
  return fingerprint;
}

function getAuthHeaders(): HeadersInit {
  const token = window.localStorage.getItem(TOKEN_KEY);
  return {
    'Content-Type': 'application/json',
    'X-Device-Fingerprint': getDeviceFingerprint(),
    'X-Device-Name': navigator.userAgent.slice(0, 80),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function defaultLicense(): LicenseState {
  return { plan: 'free', status: 'free', source: 'anonymous', endsAt: null, isPro: false };
}

export function SettingsPage({ subView }: { subView: string }) {
  const isIntegrations = subView === 'integrations';
  const [activeTab, setActiveTab] = useState<'account' | 'ai' | 'billing'>('account');
  const [auth, setAuth] = useState<AuthState>({ user: null, license: defaultLicense() });
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [redeemCode, setRedeemCode] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadAuth = async () => {
    const res = await fetch('/api/auth/me', { headers: getAuthHeaders() });
    const data = await res.json();
    if (data.status === 'success' || data.status === 'anonymous') {
      setAuth({ user: data.user ?? null, license: data.license ?? defaultLicense(), deviceCount: data.deviceCount ?? 0 });
      if (data.status === 'anonymous') {
        window.localStorage.removeItem(TOKEN_KEY);
      }
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
      setAuth({ user: null, license: defaultLicense() });
    }
  };

  useEffect(() => {
    void loadAuth();
  }, []);

  const submitAuth = async () => {
    setIsBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ email, password, displayName }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '认证失败');
      window.localStorage.setItem(TOKEN_KEY, data.token);
      setAuth({ user: data.user, license: data.license, deviceCount: data.deviceCount ?? 1 });
      setPassword('');
      setMessage(mode === 'login' ? '登录成功' : '注册成功，已创建免费版账号');
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const redeem = async () => {
    setIsBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/license/redeem', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ code: redeemCode }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '兑换失败');
      setAuth(prev => ({ ...prev, license: data.license }));
      setRedeemCode('');
      setMessage('兑换成功，授权状态已更新');
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: getAuthHeaders() }).catch(() => {});
    window.localStorage.removeItem(TOKEN_KEY);
    setAuth({ user: null, license: defaultLicense() });
    setMessage('已退出登录');
  };

  if (isIntegrations) {
    return (
      <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2 mb-8">
            <Blocks className="w-6 h-6 text-indigo-600" />
            第三方集成
          </h1>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
            第三方云同步、GitHub 和 OpenScience 仓库还未进入第一阶段。当前收费闭环先以账号、授权和兑换码为主，避免展示“已连接”的假状态。
          </div>
        </div>
      </div>
    );
  }

  const licenseLabel = auth.license.isPro ? '专业版 Pro' : '免费版 Free';
  const licenseEnd = auth.license.endsAt ? new Date(auth.license.endsAt).toLocaleString() : '未激活 Pro';

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2 mb-8">
          <Settings className="w-6 h-6 text-slate-600" />
          账号、授权与系统设置
        </h1>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex overflow-hidden min-h-[640px]">
          <div className="w-64 bg-slate-50/50 border-r border-slate-200 p-4 space-y-1.5 shrink-0">
            <button onClick={() => setActiveTab('account')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'account' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}><User className="w-4 h-4"/> 账号与授权</button>
            <button onClick={() => setActiveTab('billing')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'billing' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}><CreditCard className="w-4 h-4"/> 订阅与兑换码</button>
            <button onClick={() => setActiveTab('ai')} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'ai' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}><Cpu className="w-4 h-4"/> AI 工作流</button>
            <div className="my-2 border-t border-slate-200/60 mx-2"></div>
            <button onClick={logout} disabled={!auth.user} className="w-full flex items-center gap-3 px-3 py-2.5 text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"><LogOut className="w-4 h-4"/> 退出登录</button>
          </div>

          <div className="flex-1 p-8 space-y-8">
            {message && (
              <div className={`rounded-xl border px-4 py-3 text-sm ${message.includes('成功') || message.includes('已退出') ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                {message}
              </div>
            )}

            {activeTab === 'account' && (
              <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-black">
                      {auth.user?.email?.[0]?.toUpperCase() || 'S'}
                    </div>
                    <div>
                      <div className="font-bold text-slate-900">{auth.user ? auth.user.displayName || auth.user.email : '未登录'}</div>
                      <div className="text-xs text-slate-500">{auth.user?.email || '登录后可兑换 Pro 授权'}</div>
                    </div>
                  </div>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">当前计划</span><span className="font-bold text-slate-900">{licenseLabel}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">授权来源</span><span className="font-medium">{auth.license.source}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">有效期</span><span className="font-medium">{licenseEnd}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">活跃设备</span><span className="font-medium">{auth.deviceCount ?? 0} / 3 建议上限</span></div>
                  </div>
                </div>

                {!auth.user ? (
                  <div className="rounded-2xl border border-slate-200 bg-white p-6">
                    <div className="flex gap-2 mb-5">
                      <button onClick={() => setMode('login')} className={`px-4 py-2 rounded-lg text-sm font-semibold ${mode === 'login' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>登录</button>
                      <button onClick={() => setMode('register')} className={`px-4 py-2 rounded-lg text-sm font-semibold ${mode === 'register' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>注册</button>
                    </div>
                    <div className="space-y-4">
                      {mode === 'register' && (
                        <label className="block text-sm text-slate-600">显示名称
                          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" placeholder="例如 SZC" />
                        </label>
                      )}
                      <label className="block text-sm text-slate-600">邮箱
                        <input value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" placeholder="you@example.com" />
                      </label>
                      <label className="block text-sm text-slate-600">密码
                        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" placeholder="至少 8 位" />
                      </label>
                      <button onClick={submitAuth} disabled={isBusy} className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50">
                        {isBusy ? '处理中...' : mode === 'login' ? '登录账号' : '创建账号'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
                    <CheckCircle2 className="w-8 h-8 text-emerald-600 mb-4" />
                    <h2 className="text-lg font-bold text-emerald-900">账号已登录</h2>
                    <p className="text-sm text-emerald-700 mt-2 leading-6">当前会话 token 仅以 hash 形式保存在本地数据库；客户端只保存 bearer token，用于后续授权校验。</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'billing' && (
              <div className="max-w-2xl space-y-6">
                <div className="rounded-2xl border border-slate-200 bg-white p-6">
                  <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2"><KeyRound className="w-5 h-5 text-blue-600" /> 兑换 Pro 授权</h2>
                  <p className="text-sm text-slate-500 mt-2">输入兑换码后，系统会把授权写入订阅表。兑换码本身只保存 hash，不保存明文。</p>
                  <div className="mt-5 flex gap-3">
                    <input value={redeemCode} onChange={(e) => setRedeemCode(e.target.value)} disabled={!auth.user} className="flex-1 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm disabled:bg-slate-100" placeholder={auth.user ? 'SF-XXXXXXX-XXXXXXX' : '请先登录'} />
                    <button onClick={redeem} disabled={!auth.user || isBusy} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50">兑换</button>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
                  <h3 className="font-bold text-slate-800 flex items-center gap-2"><Shield className="w-5 h-5 text-slate-600" /> 第一阶段防滥用边界</h3>
                  <ul className="mt-3 space-y-2 text-sm text-slate-600">
                    <li>账号、订阅、兑换码校验都在服务端完成。</li>
                    <li>token 与兑换码入库前均做 SHA-256，不保存明文。</li>
                    <li>设备指纹会记录到设备表，后续可限制 1-3 台设备。</li>
                    <li>高清导出、AI API、云同步等高价值能力后续应全部走授权校验。</li>
                  </ul>
                </div>
              </div>
            )}

            {activeTab === 'ai' && (
              <div>
                <h2 className="text-xl font-bold text-slate-800 mb-1">AI 辅助工作流</h2>
                <p className="text-sm text-slate-500 mb-6">当前仍采用“复制提示词 → 网页 AI 改写 → 粘贴回来”的低依赖模式。后续接入 AI API 时，应在服务端按授权状态控制用量。</p>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 max-w-2xl">
                  <h3 className="font-semibold text-blue-800 mb-3">商业化接入建议</h3>
                  <ol className="space-y-3 text-sm text-blue-700">
                    <li className="flex gap-3"><span className="font-bold shrink-0">1.</span>免费版保留复制提示词协议。</li>
                    <li className="flex gap-3"><span className="font-bold shrink-0">2.</span>Pro 版走服务端 AI API 自动适配脚本。</li>
                    <li className="flex gap-3"><span className="font-bold shrink-0">3.</span>服务端记录 token 用量、失败原因和项目上下文。</li>
                  </ol>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
