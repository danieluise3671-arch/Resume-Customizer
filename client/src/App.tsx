import { Switch, Route } from 'wouter';
import { queryClient } from './lib/queryClient';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as SonnerToaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuth } from '@/hooks/useAuth';
import { lazy, Suspense, memo, useEffect } from 'react';
import { PageLoader } from '@/components/ui/page-loader';

// Lazy load all pages for optimal bundle splitting
const NotFound = lazy(() => import('@/pages/not-found'));
const Landing = lazy(() => import('@/pages/landing'));
const Dashboard = lazy(() => import('@/pages/dashboard'));
const MultiResumeEditorPage = lazy(() => import('@/pages/multi-resume-editor-page'));
const MarketingPage = lazy(() => import('@/pages/marketing'));
const VerifyEmail = lazy(() => import('@/pages/verify-email'));
const ResetPassword = lazy(() => import('@/pages/reset-password'));
const Privacy = lazy(() => import('@/pages/privacy'));

const Router = memo(() => {
  const { isAuthenticated, isLoading } = useAuth();

  // Preload likely next pages based on auth status
  useEffect(() => {
    if (!isLoading) {
      const preloadTimer = setTimeout(() => {
        if (isAuthenticated) {
          // Preload dashboard and marketing for authenticated users
          import('@/pages/dashboard');
          import('@/pages/marketing');
        } else {
          // Preload landing for non-authenticated users
          import('@/pages/landing');
        }
      }, 100);
      return () => clearTimeout(preloadTimer);
    }
  }, [isAuthenticated, isLoading]);

  if (isLoading) {
    return <PageLoader variant="branded" text="Loading..." />;
  }

  return (
    <Suspense
      fallback={<PageLoader variant="branded" text="Loading application..." />}
    >
      <Switch>
        {isAuthenticated ? (
          // Authenticated routes
          <>
            <Route path="/" component={Dashboard} />
            <Route path="/editor" component={MultiResumeEditorPage} />
            <Route path="/marketing" component={MarketingPage} />
            <Route path="/privacy" component={Privacy} />
          </>
        ) : (
          // Non-authenticated routes
          <>
            <Route path="/" component={Landing} />
            <Route path="/login" component={Landing} />
            <Route path="/register" component={Landing} />
            <Route path="/verify-email" component={VerifyEmail} />
            <Route path="/reset-password" component={ResetPassword} />
            <Route path="/privacy" component={Privacy} />
          </>
        )}
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
});
Router.displayName = 'Router';

import CookieConsent from '@/components/cookie-consent';
import { ErrorBoundary } from '@/components/error-boundary';

const App = memo(() => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <SonnerToaster 
            position="top-right" 
            richColors 
            closeButton
            duration={4000}
            toastOptions={{
              className: 'toast-custom',
              style: {
                background: 'hsl(var(--background))',
                color: 'hsl(var(--foreground))',
                border: '1px solid hsl(var(--border))'
              }
            }}
          />
          <Router />
          <CookieConsent />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
});
App.displayName = 'App';

export default App;
