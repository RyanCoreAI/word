import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallController } from './InstallButton';

class DisplayMode extends EventTarget {
  matches = false;
  change(matches: boolean) { this.matches = matches; this.dispatchEvent(new Event('change')); }
}
class InstallWindow extends EventTarget {
  readonly mode = new DisplayMode();
  navigator = { standalone: false };
  matchMedia = vi.fn(() => this.mode);
}
class PromptEvent extends Event {
  prompt = vi.fn(async () => {});
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  resolveChoice!: (choice: { outcome: 'accepted' | 'dismissed' }) => void;
  constructor() {
    super('beforeinstallprompt', { cancelable: true });
    this.userChoice = new Promise(resolve => { this.resolveChoice = resolve; });
  }
}
const controllers: InstallController[] = [];
function setup(standalone = false, iosStandalone = false) {
  const target = new InstallWindow();
  target.mode.matches = standalone;
  target.navigator.standalone = iosStandalone;
  const controller = new InstallController(target as unknown as Window);
  controllers.push(controller);
  return { target, controller };
}
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); });

describe('PWA install event contract (simulated events, not a real OS installation)', () => {
  it('retains the browser prompt before a button subscribes and never opens it automatically', () => {
    const { target, controller } = setup();
    const event = new PromptEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.prompt).not.toHaveBeenCalled();
    const listener = vi.fn(); const unsubscribe = controller.subscribe(listener);
    expect(controller.getSnapshot()).toMatchObject({ hasPrompt: true, installed: false, prompting: false });
    unsubscribe(); target.dispatchEvent(new Event('appinstalled'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('opens a retained prompt synchronously from the request and consumes it only once', async () => {
    const { target, controller } = setup();
    const event = new PromptEvent(); target.dispatchEvent(event);
    const result = controller.requestInstall();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ hasPrompt: false, prompting: true, installed: false });
    expect(await controller.requestInstall()).toBe('unavailable');
    event.resolveChoice({ outcome: 'dismissed' });
    expect(await result).toBe('dismissed');
    expect(await controller.requestInstall()).toBe('unavailable');
    const next = new PromptEvent(); target.dispatchEvent(next);
    expect(controller.getSnapshot()).toMatchObject({ hasPrompt: true, prompting: false, requestAccepted: false });
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an accepted request from observed app installation', async () => {
    const { target, controller } = setup();
    const event = new PromptEvent(); target.dispatchEvent(event);
    const result = controller.requestInstall(); event.resolveChoice({ outcome: 'accepted' });
    expect(await result).toBe('accepted');
    expect(controller.getSnapshot()).toMatchObject({ requestAccepted: true, installed: false, prompting: false });
    target.dispatchEvent(new Event('appinstalled'));
    expect(controller.getSnapshot()).toMatchObject({ installed: true, requestAccepted: false, hasPrompt: false });
    const afterInstall = new PromptEvent(); target.dispatchEvent(afterInstall);
    expect(afterInstall.defaultPrevented).toBe(false);
    expect(controller.getSnapshot().hasPrompt).toBe(false);
  });

  it('recognizes standalone launches and display-mode changes, including iOS standalone', () => {
    expect(setup(true).controller.getSnapshot().installed).toBe(true);
    expect(setup(false, true).controller.getSnapshot().installed).toBe(true);
    const { target, controller } = setup();
    target.dispatchEvent(new PromptEvent());
    target.mode.change(true);
    expect(controller.getSnapshot()).toMatchObject({ installed: true, hasPrompt: false });
    target.mode.change(false);
    expect(controller.getSnapshot().installed).toBe(false);
  });

  it('returns an unavailable result for missing events or rejected native prompts', async () => {
    const { target, controller } = setup();
    expect(await controller.requestInstall()).toBe('unavailable');
    const event = new PromptEvent(); event.prompt.mockRejectedValueOnce(new Error('Browser rejected the prompt'));
    target.dispatchEvent(event);
    expect(await controller.requestInstall()).toBe('unavailable');
    expect(controller.getSnapshot()).toMatchObject({ hasPrompt: false, prompting: false, installed: false });
  });

  it('removes its event listeners and ignores late choices after disposal', async () => {
    const { target, controller } = setup();
    const removeWindow = vi.spyOn(target, 'removeEventListener');
    const removeMedia = vi.spyOn(target.mode, 'removeEventListener');
    const listener = vi.fn(); controller.subscribe(listener);
    const event = new PromptEvent(); target.dispatchEvent(event);
    const result = controller.requestInstall();
    controller.dispose();
    const snapshot = controller.getSnapshot(); const calls = listener.mock.calls.length;
    event.resolveChoice({ outcome: 'accepted' }); await result;
    target.dispatchEvent(new Event('appinstalled')); target.mode.change(true);
    expect(removeWindow).toHaveBeenCalledTimes(2); expect(removeMedia).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('keeps an observed installation when an older pending prompt resolves later', async () => {
    const { target, controller } = setup();
    const event = new PromptEvent(); target.dispatchEvent(event);
    const result = controller.requestInstall();
    target.dispatchEvent(new Event('appinstalled'));
    event.resolveChoice({ outcome: 'dismissed' }); await result;
    expect(controller.getSnapshot()).toMatchObject({ installed: true, prompting: false, requestAccepted: false });
  });
});
