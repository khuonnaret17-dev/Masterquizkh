import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Application ErrorBoundary caught error:', error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen app-canvas flex items-center justify-center p-6 font-kantumruy">
          <div className="max-w-md w-full bg-[var(--theme-card)] border border-[var(--theme-border)] rounded-2xl p-8 text-center shadow-xl">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-amber-500/15 text-amber-500 flex items-center justify-center">
              <AlertTriangle className="w-7 h-7" />
            </div>
            <h1 className="text-xl font-bold text-[var(--theme-text)] mb-2">
              មានបញ្ហាបច្ចេកទេសបណ្ដោះអាសន្ន
            </h1>
            <p className="text-sm text-[var(--theme-text-muted)] mb-6 leading-relaxed">
              កម្មវិធីបានជួបកំហុសមិនរំពឹងទុក។ សូមចុចប៊ូតុងខាងក្រោមដើម្បីផ្ទុកកម្មវិធីឡើងវិញ។
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--theme-accent)] text-white font-semibold hover:opacity-90 transition cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              ផ្ទុកកម្មវិធីឡើងវិញ
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
