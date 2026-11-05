import type { DictationError } from '../../../shared/dictation';
import type { Translator } from '../../i18n/core';

export function dictationErrorMessage(error:DictationError,t:Translator):string {
  switch(error){
    case 'login-required':return t('voice.loginRequired','Sign in to ChatGPT before using dictation. If your session expired, sign in again.');
    case 'no-terminal':return t('voice.noTerminal','Select a terminal before starting dictation.');
    case 'target-closed':return t('voice.targetClosed','The original terminal is no longer available. Your transcript was kept here for recovery.');
    case 'microphone-unavailable':return t('voice.microphoneUnavailable','The selected microphone is unavailable or access was denied. Check Voice settings and try again.');
    case 'draft-not-empty':return t('voice.draftNotEmpty','The dedicated ChatGPT page contains a draft. Clear it on that page before starting dictation.');
    case 'page-changed':return t('voice.pageChanged','ChatGPT is not ready or its controls have changed. Open the page and try again.');
    case 'timeout':return t('voice.timeout','Transcription took too long. Open ChatGPT to check its status before trying again.');
    default:return t('voice.failed','Dictation could not be completed. Check ChatGPT and your microphone, then try again.');
  }
}
