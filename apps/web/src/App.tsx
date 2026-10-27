import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useRoute, navigate } from './router';
import type { Me } from './types';
import Dashboard from './pages/Dashboard';
import Session from './pages/Session';
import Settings from './pages/Settings';
import NewSession from './pages/NewSession';
import Search from './pages/Search';
import Usage from './pages/Usage';

// xterm 体积不小，只有打开终端时才加载
const Shell = lazy(() => import('./pages/Shell'));
import Login from './pages/Login';
import { Logo } from './components/Layout';
import Notifier from './components/Notifier';

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
        <Logo size={28} />
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

  let page: React.ReactNode;
  if (route.name === 'shell') {
    page = (
      <Suspense fallback={<div className="splash"><Logo size={28} /></div>}>
        <Shell id={route.id} kind={route.kind} />
      </Suspense>
    );
  } else if (route.name === 'session') page = <Session id={route.id} at={route.at} />;
  else if (route.name === 'search') page = <Search q={route.q} agent={route.agent} />;
  else if (route.name === 'new') page = <NewSession cwd={route.cwd} agent={route.agent} />;
  else if (route.name === 'usage') page = <Usage days={route.days} agent={route.agent} />;
  else if (route.name === 'settings') page = <Settings authRequired={me.authRequired} onLogout={refreshMe} />;
  else page = <Dashboard />;

  // 套餐刷新等提醒在任何页面都弹
  return (
    <>
      {page}
      <Notifier />
    </>
  );
}
