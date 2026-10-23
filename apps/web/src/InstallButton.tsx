import { useSyncExternalStore } from 'react';

interface InstallChoice { outcome: 'accepted' | 'dismissed'; platform?: string }
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<InstallChoice>;
}
export interface InstallState {
  installed: boolean;
  hasPrompt: boolean;
  prompting: boolean;
  requestAccepted: boolean;
}
const initialState: InstallState = { installed: false, hasPrompt: false, prompting: false, requestAccepted: false };

/** One page-wide listener retains browser events even before the button mounts. */
export class InstallController {
  private deferred: InstallPromptEvent | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly standalone: MediaQueryList;
  private installedEvent = false;
  private disposed = false;
  private generation = 0;
  private state: InstallState = initialState;

  constructor(private readonly target: Window) {
    this.standalone = target.matchMedia('(display-mode: standalone)');
    this.state = { ...initialState, installed: this.isInstalled() };
    target.addEventListener('beforeinstallprompt', this.beforeInstall);
    target.addEventListener('appinstalled', this.appInstalled);
    this.standalone.addEventListener('change', this.displayChanged);
  }

  getSnapshot = (): InstallState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Call directly from a click; no async work precedes the native prompt(). */
  async requestInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const prompt = this.deferred;
    if (!prompt || this.disposed || this.state.installed || this.state.prompting) return 'unavailable';
    this.deferred = null;
    const generation = ++this.generation;
    this.update({ hasPrompt: false, prompting: true, requestAccepted: false });
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (!this.disposed && generation === this.generation) {
        // Acceptance is not proof that the OS finished installation. Only the
        // appinstalled event or standalone launch sets installed=true.
        if (choice.outcome === 'accepted') this.deferred = null;
        this.update({ prompting: false, hasPrompt: this.deferred !== null, requestAccepted: choice.outcome === 'accepted' });
      }
      return choice.outcome;
    } catch {
      if (!this.disposed && generation === this.generation) this.update({ prompting: false, hasPrompt: this.deferred !== null });
      return 'unavailable';
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.deferred = null;
    this.listeners.clear();
    this.target.removeEventListener('beforeinstallprompt', this.beforeInstall);
    this.target.removeEventListener('appinstalled', this.appInstalled);
    this.standalone.removeEventListener('change', this.displayChanged);
  }

  private readonly beforeInstall = (event: Event) => {
    const candidate = event as InstallPromptEvent;
    if (this.disposed || this.isInstalled() || typeof candidate.prompt !== 'function' || !candidate.userChoice?.then) return;
    candidate.preventDefault();
    this.deferred = candidate;
    this.update({ hasPrompt: true, requestAccepted: false });
  };
  private readonly appInstalled = () => {
    this.installedEvent = true;
    this.displayChanged();
  };
  private readonly displayChanged = () => {
    if (this.disposed) return;
    const installed = this.isInstalled();
    if (installed) { this.deferred = null; this.generation += 1; }
    this.update({ installed, ...(installed ? { hasPrompt: false, prompting: false, requestAccepted: false } : {}) });
  };
  private isInstalled(): boolean {
    return this.installedEvent || this.standalone.matches || (this.target.navigator as Navigator & { standalone?: boolean }).standalone === true;
  }
  private update(patch: Partial<InstallState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

// Importing this small module registers once for the page lifetime. It neither
// downloads anything nor opens an install dialog without a user click.
const installation = typeof window !== 'undefined' ? new InstallController(window) : null;
const serverSnapshot = () => initialState;
const subscribeOnServer = () => () => {};

export interface InstallButtonProps {
  className?: string;
  label?: string;
  /** Show platform/browser menu instructions when no native event is available. */
  onHelp?: () => void;
}

export function InstallButton({ className, label = '安装应用', onHelp }: InstallButtonProps) {
  const state = useSyncExternalStore(installation?.subscribe ?? subscribeOnServer, installation?.getSnapshot ?? serverSnapshot, serverSnapshot);
  if (state.installed || state.requestAccepted || (!state.hasPrompt && !onHelp)) return null;
  const install = async () => {
    const outcome = await installation?.requestInstall();
    if (!outcome || outcome === 'unavailable') onHelp?.();
  };
  return <button type="button" className={className} onClick={() => { void install(); }} disabled={state.prompting} aria-busy={state.prompting || undefined}>{state.prompting ? '正在打开安装…' : label}</button>;
}
