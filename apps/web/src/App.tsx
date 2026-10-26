import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useRoute, navigate } from './router';
import type { Me } from './types';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Settings from './pages/Settings';
import NewSession from './pages/NewSession';

// xterm 体积不小，只有打开终端时才加载
const Shell = lazy(() => import('./pages/Shell'));
import Login from './pages/Login';

export default function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ authRequired: true, authenticated: false }));
  }, []);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  if (!me) {
    return (
      <div className="splash">
        <span className="splash__mark">agentctl</span>
      </div>
    );
  }

  if (me.authRequired && !me.authenticated) {
    return (
      <Login
        onDone={() => {
          refreshMe();
          if (route.name === 'login') navigate('/');
        }}
      />
    );
  }

  if (route.name === 'login') {
    navigate('/');
    return null;
  }

  if (route.name === 'shell') {
    return (
      <Suspense fallback={<div className="splash"><span className="splash__mark">agentctl</span></div>}>
        <Shell id={route.id} kind={route.kind} />
      </Suspense>
    );
  }
  if (route.name === 'session') return <Session id={route.id} />;
  if (route.name === 'new') return <NewSession cwd={route.cwd} agent={route.agent} />;
  if (route.name === 'settings') return <Settings authRequired={me.authRequired} onLogout={refreshMe} />;
  return <Dashboard />;
}
