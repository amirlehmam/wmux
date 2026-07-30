import React, { useState } from 'react';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import '../../styles/tutorial.css';

interface TutorialProps {
  onClose: () => void;
}

interface Step {
  title: string;
  body: string;
  shortcuts: string[];
}

function buildSteps(t: (key: TranslationKey, fallback?: string) => string): Step[] {
  return [
    {
      title: t('tutorial.step.welcome.title', 'Welcome to wmux'),
      body: t(
        'tutorial.step.welcome.body',
        'wmux is a terminal multiplexer for running AI coding agents in parallel. This quick tour will show you the essentials.',
      ),
      shortcuts: [],
    },
    {
      title: t('tutorial.step.workspaces.title', 'Workspaces'),
      body: t(
        'tutorial.step.workspaces.body',
        'The sidebar on the left shows your workspaces. Each workspace is an independent session with its own terminal layout. Create new ones with Ctrl+N. Double-click a workspace title to rename it.',
      ),
      shortcuts: ['Ctrl+N', 'Ctrl+B'],
    },
    {
      title: t('tutorial.step.splitPanes.title', 'Split Panes'),
      body: t(
        'tutorial.step.splitPanes.body',
        'Split your terminals horizontally or vertically. Each pane runs its own shell. Drag dividers to resize. Zoom any pane to full size with Ctrl+Shift+Enter.',
      ),
      shortcuts: ['Ctrl+D', 'Ctrl+Shift+D'],
    },
    {
      title: t('tutorial.step.surfaceTabs.title', 'Surface Tabs'),
      body: t(
        'tutorial.step.surfaceTabs.body',
        'Each pane can have multiple tabs — terminals, browser panels, or markdown views. Drag tabs between panes to reorganize. Create new tabs with Ctrl+T.',
      ),
      shortcuts: ['Ctrl+T', 'Ctrl+W'],
    },
    {
      title: t('tutorial.step.browserPanel.title', 'Browser Panel'),
      body: t(
        'tutorial.step.browserPanel.body',
        'The browser panel on the right lets you preview what your agents build. Toggle it with Ctrl+Shift+I. Navigate to localhost or any URL. The browser is scriptable via the socket API.',
      ),
      shortcuts: ['Ctrl+Shift+I'],
    },
    {
      title: t('tutorial.step.notifications.title', 'Notifications'),
      body: t(
        'tutorial.step.notifications.body',
        'When an agent needs your attention, its pane gets a blue ring and the workspace badge increments. A Windows toast notification fires too. Jump to the latest unread with Ctrl+Shift+U.',
      ),
      shortcuts: ['Ctrl+Shift+U'],
    },
    {
      title: t('tutorial.step.allSet.title', "You're all set"),
      body: t(
        'tutorial.step.allSet.body',
        "You can always reopen this guide from the help button (?) in the title bar. For the full keyboard shortcuts, open Settings with Ctrl+, or the Command Palette with Ctrl+Shift+P.",
      ),
      shortcuts: [],
    },
  ];
}

export default function Tutorial({ onClose }: TutorialProps) {
  const t = useT();
  const [currentStep, setCurrentStep] = useState(0);

  const STEPS = buildSteps(t);
  const step = STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;

  const handleNext = () => {
    if (!isLast) setCurrentStep((s) => s + 1);
  };

  const handlePrevious = () => {
    if (!isFirst) setCurrentStep((s) => s - 1);
  };

  return (
    <div className="tutorial-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="tutorial-card">
        {!isLast && (
          <button className="tutorial-skip" onClick={onClose}>
            {t('tutorial.skip', 'Skip')}
          </button>
        )}

        <div className="tutorial-dots">
          {STEPS.map((_, idx) => (
            <div
              key={idx}
              className={`tutorial-dot${idx === currentStep ? ' tutorial-dot--active' : ''}`}
            />
          ))}
        </div>

        <h2 className="tutorial-title">{step.title}</h2>
        <p className="tutorial-body">{step.body}</p>

        {step.shortcuts.length > 0 && (
          <div className="tutorial-shortcuts">
            {step.shortcuts.map((shortcut) => (
              <span key={shortcut} className="tutorial-shortcut">
                {shortcut}
              </span>
            ))}
          </div>
        )}

        <div className="tutorial-nav">
          <button
            className="tutorial-btn tutorial-btn--secondary"
            onClick={handlePrevious}
            disabled={isFirst}
          >
            {t('tutorial.previous', 'Previous')}
          </button>

          <span className="tutorial-step-counter">
            {currentStep + 1} / {STEPS.length}
          </span>

          {isLast ? (
            <button className="tutorial-btn tutorial-btn--primary" onClick={onClose}>
              {t('tutorial.getStarted', 'Get Started')}
            </button>
          ) : (
            <button className="tutorial-btn tutorial-btn--primary" onClick={handleNext}>
              {t('tutorial.next', 'Next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
