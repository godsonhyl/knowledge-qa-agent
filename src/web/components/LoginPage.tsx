/* ============================================================
   web/components/LoginPage.tsx —— SSO 登录页（参照 WeKnora login 布局）
   左侧品牌展示区 + 右侧表单卡（form-card / oidc-button / login-features）。
   纯 SSO：无用户名密码输入框，单按钮跳 /api/auth/oidc/login。
   ============================================================ */
import { Button } from 'tdesign-react';
import { useState } from 'react';

export function LoginPage({ providerName, required }: { providerName: string; required: boolean }) {
  const [redirecting, setRedirecting] = useState(false);

  function onLogin() {
    setRedirecting(true);
    window.location.href = '/api/auth/oidc/login';
  }

  return (
    <div className="login-layout">
      {/* 左：品牌展示区（窄屏隐藏） */}
      <div className="login-showcase">
        <div className="login-brand">
          <div className="brand-mark">知</div>
          <h1>知识问答 Agent</h1>
          <p className="login-brand-sub">每条回答都标出处</p>
        </div>
        <div className="login-features">
          <div className="feature-item">
            <span className="feature-icon">溯源</span>
            <span className="feature-text">每个结论带 [n] 引用，点击直达原文行</span>
          </div>
          <div className="feature-item">
            <span className="feature-icon">混合检索</span>
            <span className="feature-text">BM25 词法 + bge-m3 向量双通道，RRF 融合精排</span>
          </div>
          <div className="feature-item">
            <span className="feature-icon">防幻觉</span>
            <span className="feature-text">检索无据直接拒答，绝不用模型记忆冒充知识库</span>
          </div>
        </div>
      </div>

      {/* 右：登录表单卡 */}
      <div className="login-panel">
        <div className="form-card">
          <div className="form-header">
            <div className="form-title">登录</div>
            <div className="form-welcome">欢迎使用知识问答 Agent</div>
            {!required && <div className="form-hint">本系统登录为可选项，直接访问首页也可使用</div>}
          </div>
          <div className="form-content">
            <Button
              className="oidc-button"
              theme="primary"
              size="large"
              block
              loading={redirecting}
              disabled={redirecting}
              onClick={onLogin}
            >{redirecting ? '正在跳转到 SSO…' : (providerName || 'SSO 登录')}</Button>
          </div>
          <div className="form-footer">
            <span className="form-hint">登录由企业统一身份认证（Keycloak）完成，本系统不保存密码</span>
          </div>
        </div>
      </div>
    </div>
  );
}
