/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import {GoogleGenAI, GenerateContentResponse} from '@google/genai';
import {marked} from 'marked';

const MODEL_NAME = 'gemini-2.5-flash-preview-04-17';
const LOCAL_STORAGE_NOTES_KEY = 'voiceNotesApp_notes';
const LOCAL_STORAGE_LAST_NOTE_ID_KEY = 'voiceNotesApp_lastNoteId';

interface Note {
  id: string;
  title: string;
  rawTranscription: string;
  polishedNote: string;
  timestamp: number; // Last modified
}

class VoiceNotesApp {
  private genAI: GoogleGenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement;
  private newButton: HTMLButtonElement;
  private themeToggleButton: HTMLButtonElement;
  private themeToggleIcon: HTMLElement;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  
  private stream: MediaStream | null = null;
  private editorTitleElement: HTMLDivElement;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  // Note Management
  private notes: Note[] = [];
  private currentNoteId: string | null = null;
  private noteListElement: HTMLUListElement;
  private exportNoteButton: HTMLButtonElement;
  private clearAllNotesButton: HTMLButtonElement;

  private markedLoggedError = false; // Flag to log marked error only once

  constructor() {
    this.genAI = new GoogleGenAI({
      apiKey: process.env.API_KEY!, // Updated API Key usage
    });

    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.polishedNote = document.getElementById(
      'polishedNote',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.themeToggleButton = document.getElementById(
      'themeToggleButton',
    ) as HTMLButtonElement;
    this.themeToggleIcon = this.themeToggleButton.querySelector(
      'i',
    ) as HTMLElement;
    this.editorTitleElement = document.getElementById(
      'editorTitle',
    ) as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;

    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    } else {
      console.warn(
        '[VoiceNotesApp] Live waveform canvas element not found. Visualizer will not work.',
      );
    }
    
    this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    

    // Note Management Elements
    this.noteListElement = document.getElementById('noteList') as HTMLUListElement;
    this.exportNoteButton = document.getElementById('exportNoteButton') as HTMLButtonElement;
    this.clearAllNotesButton = document.getElementById('clearAllNotesButton') as HTMLButtonElement;

    this.bindEventListeners();
    this.initTheme();
    this.loadNotes(); // Load existing notes first
    this.initializeCurrentNote(); // Then determine which note to show

    this.recordingStatus.textContent = 'Ready to record';
    console.log('[VoiceNotesApp] App initialized.');
  }

  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.handleNewNoteRequest());
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    window.addEventListener('resize', this.handleResize.bind(this));

    // Auto-save listeners
    this.editorTitleElement.addEventListener('blur', () => this.handleEditorBlur('title'));
    this.rawTranscription.addEventListener('blur', () => this.handleEditorBlur('raw'));
    this.polishedNote.addEventListener('blur', () => this.handleEditorBlur('polished'));
    
    // Note Management Listeners
    this.exportNoteButton.addEventListener('click', () => this.exportCurrentNote());
    this.clearAllNotesButton.addEventListener('click', () => this.handleClearAllNotes());

    // Placeholder handling for contenteditable
     document.querySelectorAll<HTMLElement>('[contenteditable][placeholder]').forEach(el => {
        const placeholder = el.getAttribute('placeholder')!;
        const updatePlaceholder = () => this.updatePlaceholderState(el, placeholder);
        
        el.addEventListener('focus', () => {
            if (el.classList.contains('placeholder-active')) {
                if (el.id === 'polishedNote') el.innerHTML = ''; else el.textContent = '';
                el.classList.remove('placeholder-active');
            }
        });
        el.addEventListener('blur', updatePlaceholder); // Also update on blur after content change
        updatePlaceholder(); // Initial check
    });
  }
  
  private updatePlaceholderState(el: HTMLElement, placeholder: string): void {
    const currentText = (el.id === 'polishedNote' ? el.innerText : el.textContent)?.trim();
    // Check if the current content is exactly the placeholder string itself
    const isContentPlaceholder = (el.id === 'polishedNote' && el.innerHTML === placeholder) || 
                                 (el.id !== 'polishedNote' && el.textContent === placeholder);

    if (currentText === '' || (el.classList.contains('placeholder-active') && isContentPlaceholder)) {
        if (el.id === 'polishedNote' && el.innerHTML !== placeholder) el.innerHTML = placeholder;
        else if (el.id !== 'polishedNote' && el.textContent !== placeholder) el.textContent = placeholder;
        el.classList.add('placeholder-active');
    } else {
        el.classList.remove('placeholder-active');
    }
  }


  private handleEditorBlur(type: 'title' | 'raw' | 'polished'): void {
    if (!this.currentNoteId) return;
    const note = this.notes.find(n => n.id === this.currentNoteId);
    if (!note) return;

    let changed = false;
    if (type === 'title') {
      const newTitle = this.editorTitleElement.textContent?.trim() || 'Untitled Note';
      if (this.editorTitleElement.classList.contains('placeholder-active')) {
        // If placeholder is active, actual title should be considered empty or default
        if (note.title !== 'Untitled Note') { note.title = 'Untitled Note'; changed = true; }
      } else if (note.title !== newTitle) {
        note.title = newTitle;
        changed = true;
      }
    } else if (type === 'raw') {
      const newRaw = this.rawTranscription.textContent?.trim() || '';
      if (this.rawTranscription.classList.contains('placeholder-active')) {
         if (note.rawTranscription !== '') { note.rawTranscription = ''; changed = true; }
      } else if (note.rawTranscription !== newRaw) {
        note.rawTranscription = newRaw;
        changed = true;
      }
    } else if (type === 'polished') {
      // For polishedNote, we store the markdown (text), but compare against innerText for changes from user editing
      // because innerHTML might contain complex HTML from marked.parse()
      const currentPolishedTextContent = this.polishedNote.innerText?.trim() || '';
      if (this.polishedNote.classList.contains('placeholder-active')) {
         if (note.polishedNote !== '') { note.polishedNote = ''; changed = true; }
      } else if (note.polishedNote !== currentPolishedTextContent) { 
        // Assuming direct edits to polishedNote mean the user is overriding the markdown.
        // We should store this new text as the "markdown" source.
        note.polishedNote = currentPolishedTextContent; 
        changed = true;
      }
    }

    if (changed) {
      note.timestamp = Date.now();
      this.saveNotes();
      this.renderNoteList(); // Re-render to reflect potential title/timestamp changes
    }
    // Ensure placeholders are correct after blur, especially if content was cleared
    this.updatePlaceholderState(this.editorTitleElement, this.editorTitleElement.getAttribute('placeholder')!);
    this.updatePlaceholderState(this.rawTranscription, this.rawTranscription.getAttribute('placeholder')!);
    this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);
  }


  private initializeCurrentNote(): void {
    const lastNoteId = localStorage.getItem(LOCAL_STORAGE_LAST_NOTE_ID_KEY);
    console.log(`[VoiceNotesApp] initializeCurrentNote: Last viewed note ID from localStorage: ${lastNoteId}`);
    if (lastNoteId && this.notes.find(n => n.id === lastNoteId)) {
      console.log(`[VoiceNotesApp] initializeCurrentNote: Selecting last viewed note ID: ${lastNoteId}`);
      this.selectNote(lastNoteId);
    } else if (this.notes.length > 0) {
      // Notes are sorted by timestamp (desc) in loadNotes, so notes[0] is the most recent
      console.log(`[VoiceNotesApp] initializeCurrentNote: Selecting most recent note ID: ${this.notes[0].id}`);
      this.selectNote(this.notes[0].id); 
    } else {
      console.log('[VoiceNotesApp] initializeCurrentNote: No notes found, creating a new initial note.');
      this.createNewNote(true); // Create a new note if no notes exist
    }
  }


  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      document.body.classList.remove('light-mode');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
      localStorage.setItem('theme', 'light');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      localStorage.setItem('theme', 'dark');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private async toggleRecording(): Promise<void> {
    if (!this.currentNoteId) {
        this.recordingStatus.textContent = "Please select or create a note first.";
        return;
    }
    if (!this.isRecording) {
      await this.startRecording();
    } else {
      await this.stopRecording();
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return;

    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.75;

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);

    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5);

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars));
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1;
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      console.warn(
        '[VoiceNotesApp] One or more live display elements are missing. Cannot start live display.',
      );
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }
    
    const currentNote = this.notes.find(n => n.id === this.currentNoteId);
    this.liveRecordingTitle.textContent = currentNote?.title || 'New Recording';


    this.setupAudioVisualizer();
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }

    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext
          .close()
          .catch((e) => console.warn('[VoiceNotesApp] Error closing audio context', e));
      }
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.waveformDataArray = null;
  }

  private async startRecording(): Promise<void> {
    try {
      this.audioChunks = [];
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
      }

      this.recordingStatus.textContent = 'Requesting microphone access...';

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        console.error('[VoiceNotesApp] Failed with basic constraints:', err);
        // Fallback to less restrictive constraints if the preferred ones fail
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { // Try common constraints that are widely supported
            echoCancellation: true, // Standard echo cancellation
            noiseSuppression: true, // Standard noise suppression
          },
        });
      }

      try {
        this.mediaRecorder = new MediaRecorder(this.stream, {
          mimeType: 'audio/webm', // Prefer webm
        });
      } catch (e) {
        console.warn('[VoiceNotesApp] audio/webm not supported, trying default or audio/ogg:', e);
        try {
            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/ogg; codecs=opus' });
        } catch (e2) {
            console.warn('[VoiceNotesApp] audio/ogg not supported, trying default MediaRecorder:', e2);
            this.mediaRecorder = new MediaRecorder(this.stream); // System default
        }
      }
      console.log("[VoiceNotesApp] Using MIME type:", this.mediaRecorder.mimeType);


      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        this.stopLiveDisplay();

        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, {
            type: this.mediaRecorder?.mimeType || 'audio/webm', // Fallback, should be set
          });
          this.processAudio(audioBlob).catch((err) => {
            console.error('[VoiceNotesApp] Error processing audio:', err);
            this.recordingStatus.textContent = 'Error processing recording';
          });
        } else {
          this.recordingStatus.textContent =
            'No audio data captured. Please try again.';
        }

        if (this.stream) {
          this.stream.getTracks().forEach((track) => {
            track.stop();
          });
          this.stream = null;
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;

      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Stop Recording');
      this.newButton.disabled = true; 
      this.exportNoteButton.disabled = true;
      this.clearAllNotesButton.disabled = true; 
      this.noteListElement.style.pointerEvents = 'none'; 

      this.startLiveDisplay();
    } catch (error) {
      console.error('[VoiceNotesApp] Error starting recording:', error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';

      if (
        errorName === 'NotAllowedError' ||
        errorName === 'PermissionDeniedError'
      ) {
        this.recordingStatus.textContent =
          'Microphone permission denied. Check browser settings and reload.';
      } else if (
        errorName === 'NotFoundError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Requested device not found'))
      ) {
        this.recordingStatus.textContent =
          'No microphone found. Please connect a microphone.';
      } else if (
        errorName === 'NotReadableError' ||
        errorName === 'AbortError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Failed to allocate audiosource'))
      ) {
        this.recordingStatus.textContent =
          'Cannot access microphone. It may be in use by another application.';
      } else if (errorName === 'TypeError' && errorMessage.includes('MediaRecorder')) {
        this.recordingStatus.textContent = 
          'MediaRecorder not supported or no suitable audio format found.';
      } else {
        this.recordingStatus.textContent = `Mic Error: ${errorMessage.substring(0, 50)}`;
      }

      this.isRecording = false;
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.newButton.disabled = false;
      this.exportNoteButton.disabled = false;
      this.clearAllNotesButton.disabled = false;
      this.noteListElement.style.pointerEvents = 'auto';
      this.stopLiveDisplay();
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop(); // onstop will handle the rest
      } catch (e) {
        console.error('[VoiceNotesApp] Error stopping MediaRecorder:', e);
        this.stopLiveDisplay(); // Ensure UI is reset if stop fails badly
      }

      this.isRecording = false;

      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.newButton.disabled = false;
      this.exportNoteButton.disabled = false;
      this.clearAllNotesButton.disabled = false;
      this.noteListElement.style.pointerEvents = 'auto';
      this.recordingStatus.textContent = 'Processing audio...';
    } else {
      // If somehow called when not recording, ensure UI is consistent
      if (!this.isRecording) {
        this.stopLiveDisplay();
        this.recordButton.classList.remove('recording');
        this.recordButton.setAttribute('title', 'Start Recording');
        this.newButton.disabled = false;
        this.exportNoteButton.disabled = false;
        this.clearAllNotesButton.disabled = false;
        this.noteListElement.style.pointerEvents = 'auto';
      }
    }
  }

  private async processAudio(audioBlob: Blob): Promise<void> {
    if (audioBlob.size === 0) {
      this.recordingStatus.textContent =
        'No audio data captured. Please try again.';
      return;
    }
    const currentNote = this.notes.find(n => n.id === this.currentNoteId);
    if (!currentNote) {
        this.recordingStatus.textContent = "Error: No active note to save recording to.";
        return;
    }

    try {
      this.recordingStatus.textContent = 'Converting audio...';

      const reader = new FileReader();
      const readResult = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          try {
            const base64data = reader.result as string;
            const base64Audio = base64data.split(',')[1];
            resolve(base64Audio);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(reader.error);
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await readResult;

      if (!base64Audio) throw new Error('Failed to convert audio to base64');

      const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
      await this.getTranscription(base64Audio, mimeType);
    } catch (error) {
      console.error('[VoiceNotesApp] Error in processAudio:', error);
      this.recordingStatus.textContent =
        'Error processing recording. Please try again.';
    }
  }

  private async getTranscription(
    base64Audio: string,
    mimeType: string,
  ): Promise<void> {
    const currentNote = this.notes.find(n => n.id === this.currentNoteId);
    if (!currentNote) return;

    try {
      this.recordingStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Getting transcription...';

      const contents = [
        {text: 'Generate a complete, detailed transcript of this audio.'},
        {inlineData: {mimeType: mimeType, data: base64Audio}},
      ];

      const response: GenerateContentResponse = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });

      const transcriptionText = response.text; 

      if (transcriptionText) {
        this.rawTranscription.textContent = transcriptionText;
        this.updatePlaceholderState(this.rawTranscription, this.rawTranscription.getAttribute('placeholder')!);
        
        currentNote.rawTranscription = transcriptionText;
        currentNote.timestamp = Date.now();
        this.saveNotes();
        this.renderNoteList();

        this.recordingStatus.innerHTML = '<i class="fas fa-check-circle"></i> Transcription complete. Polishing...';
        this.getPolishedNote().catch((err) => {
          console.error('[VoiceNotesApp] Error polishing note:', err);
          this.recordingStatus.textContent =
            'Error polishing note after transcription.';
        });
      } else {
        this.recordingStatus.textContent =
          'Transcription failed or returned empty.';
        this.polishedNote.innerHTML =
          '<p><em>Could not transcribe audio. Please try again.</em></p>';
        this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);
        
        this.rawTranscription.textContent = this.rawTranscription.getAttribute('placeholder');
        if(this.rawTranscription.textContent) this.rawTranscription.classList.add('placeholder-active');

      }
    } catch (error) {
      console.error('[VoiceNotesApp] Error getting transcription:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.recordingStatus.textContent =
        `Transcription Error: ${errorMessage.substring(0,100)}`;
      this.polishedNote.innerHTML = `<p><em>Error during transcription: ${errorMessage}</em></p>`;
      this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);

      this.rawTranscription.textContent = this.rawTranscription.getAttribute('placeholder');
      if(this.rawTranscription.textContent) this.rawTranscription.classList.add('placeholder-active');
    }
  }

  private async getPolishedNote(): Promise<void> {
    const currentNote = this.notes.find(n => n.id === this.currentNoteId);
    if (!currentNote || !currentNote.rawTranscription.trim()) {
      this.recordingStatus.textContent = 'No transcription to polish.';
      this.polishedNote.innerHTML = this.polishedNote.getAttribute('placeholder')!;
      this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);
      return;
    }

    try {
      this.recordingStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Polishing note...';

      const prompt = `Take this raw transcription and create a polished, well-formatted note.
                    Remove filler words (um, uh, like), repetitions, and false starts.
                    Format any lists or bullet points properly. Use markdown formatting for headings, lists, etc.
                    Maintain all the original content and meaning.

                    Raw transcription:
                    ${currentNote.rawTranscription}`;
      const contents = [{text: prompt}];

      const response: GenerateContentResponse = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: contents,
      });
      const polishedText = response.text; 

      if (polishedText) {
        if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function') {
            this.polishedNote.innerHTML = marked.parse(polishedText) as string;
        } else {
            this.polishedNote.textContent = polishedText; // Fallback to raw text
            if (!this.markedLoggedError) {
                console.error("[VoiceNotesApp] Marked library is not available. Polished notes will be displayed as raw Markdown.");
                this.markedLoggedError = true;
            }
        }
        this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);

        currentNote.polishedNote = polishedText; 
        
        let noteTitleSet = false;
        const lines = polishedText.split('\n').map((l) => l.trim());

        for (const line of lines) {
          if (line.startsWith('# ')) { 
            const title = line.replace(/^#+\s+/, '').trim();
            if (title) {
              currentNote.title = title;
              this.editorTitleElement.textContent = title;
              this.updatePlaceholderState(this.editorTitleElement, this.editorTitleElement.getAttribute('placeholder')!);
              noteTitleSet = true;
              break;
            }
          }
        }
        
        if (!noteTitleSet) {
            for (const line of lines) {
                if (line.length > 0 && !line.match(/^[\*_\`#\->\s\[\]\(.\d)]/)) { 
                    let potentialTitle = line.replace(/[\*_\`#]+$/, '').trim();
                    if (potentialTitle.length > 3) {
                        const maxLength = 60;
                        currentNote.title = potentialTitle.substring(0, maxLength) + (potentialTitle.length > maxLength ? '...' : '');
                        this.editorTitleElement.textContent = currentNote.title;
                        this.updatePlaceholderState(this.editorTitleElement, this.editorTitleElement.getAttribute('placeholder')!);
                        noteTitleSet = true;
                        break;
                    }
                }
            }
        }

        currentNote.timestamp = Date.now();
        this.saveNotes();
        this.renderNoteList(); 

        this.recordingStatus.textContent =
          'Note polished. Ready for next recording.';
      } else {
        this.recordingStatus.textContent =
          'Polishing failed or returned empty.';
        this.polishedNote.innerHTML =
          '<p><em>Polishing returned empty. Raw transcription is available.</em></p>';
        this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);
      }
    } catch (error) {
      console.error('[VoiceNotesApp] Error polishing note:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.recordingStatus.textContent = `Polishing Error: ${errorMessage.substring(0,100)}`;
      this.polishedNote.innerHTML = `<p><em>Error during polishing: ${errorMessage}</em></p>`;
      this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);
    }
  }

  private handleNewNoteRequest(): void {
    const currentNote = this.notes.find(n => n.id === this.currentNoteId);
    if (currentNote) {
        const rawContent = this.rawTranscription.classList.contains('placeholder-active') ? '' : this.rawTranscription.textContent?.trim();
        const polishedContent = this.polishedNote.classList.contains('placeholder-active') ? '' : this.polishedNote.innerText?.trim(); 
        
        if (rawContent || polishedContent) {
            if (!confirm('Current note has content. Create a new note anyway? Unsaved changes in the editor might be lost.')) {
                return;
            }
        }
    }
    this.createNewNote();
  }

  private createNewNote(isInitialSetup = false): void {
    console.log(`[VoiceNotesApp] createNewNote called. isInitialSetup: ${isInitialSetup}`);
    if (this.isRecording) {
      this.mediaRecorder?.stop(); 
      this.isRecording = false; 
    } else {
      this.stopLiveDisplay(); 
    }
    
    this.recordButton.classList.remove('recording');
    this.recordButton.setAttribute('title', 'Start Recording');
    const iconElement = this.recordButton.querySelector('.record-button-inner i') as HTMLElement;
    if (iconElement) {
        iconElement.classList.remove('fa-stop');
        iconElement.classList.add('fa-microphone');
    }
    this.newButton.disabled = false;
    this.exportNoteButton.disabled = false;
    this.clearAllNotesButton.disabled = false;
    this.noteListElement.style.pointerEvents = 'auto';


    const newNote: Note = {
      id: `note_${Date.now()}_${Math.random().toString(36).substring(2,7)}`,
      title: `New Note ${this.notes.length + 1}`,
      rawTranscription: '',
      polishedNote: '',
      timestamp: Date.now(),
    };
    console.log(`[VoiceNotesApp] New note created with ID: ${newNote.id}, Title: ${newNote.title}`);

    this.notes.unshift(newNote); 
    this.currentNoteId = newNote.id; 
    console.log(`[VoiceNotesApp] Current note ID set to: ${this.currentNoteId}. Total notes: ${this.notes.length}`);
    
    this.saveNotes(); 
    this.selectNote(newNote.id); 

    if (!isInitialSetup) {
        this.recordingStatus.textContent = 'New note created. Ready to record.';
    }
  }
  
  private selectNote(noteId: string): void {
    console.log(`[VoiceNotesApp] selectNote called for ID: ${noteId}. Current notes count: ${this.notes.length}`);
    const noteToSelect = this.notes.find(n => n.id === noteId);

    if (!noteToSelect) {
        console.warn(`[VoiceNotesApp] Note with ID ${noteId} not found for selection.`);
        if (this.notes.length > 0) {
            this.currentNoteId = this.notes[0].id; // Already sorted, notes[0] is most recent
            console.log(`[VoiceNotesApp] Fallback: Selecting most recent note ID: ${this.currentNoteId}`);
        } else {
            console.log('[VoiceNotesApp] Fallback: No notes exist, creating a new initial note through selectNote fallback.');
            this.createNewNote(true); 
            return; 
        }
        const newCurrentNote = this.notes.find(n => n.id === this.currentNoteId);
        if(!newCurrentNote) {
          console.error('[VoiceNotesApp] Critical error: No note found even after fallback in selectNote.');
          this.editorTitleElement.textContent = '';
          this.rawTranscription.textContent = '';
          this.polishedNote.innerHTML = '';
        } else {
          this.editorTitleElement.textContent = newCurrentNote.title;
          this.rawTranscription.textContent = newCurrentNote.rawTranscription;
          if (newCurrentNote.polishedNote) {
              if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function') {
                  this.polishedNote.innerHTML = marked.parse(newCurrentNote.polishedNote) as string;
              } else {
                  this.polishedNote.textContent = newCurrentNote.polishedNote;
                   if (!this.markedLoggedError) {
                      console.error("[VoiceNotesApp] Marked library is not available. Polished notes will be displayed as raw Markdown.");
                      this.markedLoggedError = true;
                  }
              }
          } else {
              this.polishedNote.innerHTML = '';
          }
        }
    } else {
        this.currentNoteId = noteId;
        console.log(`[VoiceNotesApp] Successfully selected note ID: ${this.currentNoteId}. Title: ${noteToSelect.title}`);
        this.editorTitleElement.textContent = noteToSelect.title;
        this.rawTranscription.textContent = noteToSelect.rawTranscription;
        if (noteToSelect.polishedNote) {
            if (typeof marked !== 'undefined' && marked && typeof marked.parse === 'function') {
                this.polishedNote.innerHTML = marked.parse(noteToSelect.polishedNote) as string;
            } else {
                this.polishedNote.textContent = noteToSelect.polishedNote; 
                 if (!this.markedLoggedError) {
                    console.error("[VoiceNotesApp] Marked library is not available. Polished notes will be displayed as raw Markdown.");
                    this.markedLoggedError = true;
                }
            }
        } else {
            this.polishedNote.innerHTML = '';
        }
    }
    
    try {
        if (this.currentNoteId) { 
            localStorage.setItem(LOCAL_STORAGE_LAST_NOTE_ID_KEY, this.currentNoteId);
            console.log(`[VoiceNotesApp] Saved last viewed note ID to localStorage: ${this.currentNoteId}`);
        } else {
            localStorage.removeItem(LOCAL_STORAGE_LAST_NOTE_ID_KEY);
            console.log('[VoiceNotesApp] Removed last viewed note ID from localStorage as currentNoteId is null.');
        }
    } catch (error) {
        console.error("[VoiceNotesApp] Error setting/removing last viewed note ID in localStorage:", error);
        this.recordingStatus.textContent = "Warning: Could not save last viewed note preference.";
    }

    this.updatePlaceholderState(this.editorTitleElement, this.editorTitleElement.getAttribute('placeholder')!);
    this.updatePlaceholderState(this.rawTranscription, this.rawTranscription.getAttribute('placeholder')!);
    this.updatePlaceholderState(this.polishedNote, this.polishedNote.getAttribute('placeholder')!);

    this.renderNoteList(); 
    this.recordingStatus.textContent = 'Ready to record';
  }

 private deleteNote(noteId: string): void {
    console.log(`[VoiceNotesApp] deleteNote called for ID: ${noteId}. Current note ID: ${this.currentNoteId}`);
    if (!noteId) {
        console.warn("[VoiceNotesApp] DeleteNote: Called with invalid noteId.");
        return;
    }
    if (this.isRecording) {
        alert("Please stop recording before deleting a note.");
        console.log("[VoiceNotesApp] DeleteNote: Aborted, recording in progress.");
        return;
    }

    if (!confirm('Are you sure you want to delete this note? This cannot be undone.')) {
        console.log("[VoiceNotesApp] DeleteNote: User cancelled deletion.");
        return;
    }
    console.log("[VoiceNotesApp] DeleteNote: User confirmed deletion.");

    const noteIndex = this.notes.findIndex(note => note.id === noteId);

    if (noteIndex === -1) {
        console.warn("[VoiceNotesApp] DeleteNote: Note ID not found in current notes array:", noteId, ". Aborting delete.");
        this.renderNoteList(); 
        return; 
    }
    console.log(`[VoiceNotesApp] DeleteNote: Note found at index ${noteIndex}. Notes count before splice: ${this.notes.length}`);

    this.notes.splice(noteIndex, 1); 
    console.log(`[VoiceNotesApp] DeleteNote: Note spliced. Notes count after splice: ${this.notes.length}`);

    const wasCurrentNoteDeleted = (this.currentNoteId === noteId);
    
    if (wasCurrentNoteDeleted) {
        this.currentNoteId = null; 
        console.log("[VoiceNotesApp] DeleteNote: Current note ID set to null because it was deleted.");
    }

    this.saveNotes(); // Persist changes (this.notes array is sorted here)

    if (this.notes.length === 0) {
        console.log("[VoiceNotesApp] DeleteNote: No notes left after deletion. Creating a new initial note.");
        this.createNewNote(true);
    } else {
        // Notes still exist. Determine which note to select.
        if (wasCurrentNoteDeleted) {
            // The current note was deleted (this.currentNoteId is now null).
            // Select the new top-most note (most recent after sorting in saveNotes).
            const newTopNoteId = this.notes[0].id;
            console.log(`[VoiceNotesApp] DeleteNote: Deleted note was current. Selecting new most recent: ${newTopNoteId}`);
            this.selectNote(newTopNoteId);
        } else {
            // A different note was deleted. The current note (this.currentNoteId) should still be valid.
            // Re-select the current note to ensure the list UI (especially highlighting) is correct.
            // It's also a safeguard if this.currentNoteId was somehow null or invalid even if not the deleted note.
            if (this.currentNoteId && this.notes.find(n => n.id === this.currentNoteId)) {
                 console.log(`[VoiceNotesApp] DeleteNote: Deleted a different note. Re-selecting current note to refresh UI: ${this.currentNoteId}`);
                 this.selectNote(this.currentNoteId);
            } else {
                 // Fallback: currentNoteId is invalid or was null. Select the new top-most note.
                 const fallbackTopNoteId = this.notes[0].id;
                 console.log(`[VoiceNotesApp] DeleteNote: Current note ID is invalid/null (and deleted note was not current). Selecting most recent as fallback: ${fallbackTopNoteId}`);
                 this.selectNote(fallbackTopNoteId);
            }
        }
    }
    console.log(`[VoiceNotesApp] deleteNote for ID ${noteId} completed. Current selected note ID is now: ${this.currentNoteId}`);
  }


  private loadNotes(): void {
    const savedNotes = localStorage.getItem(LOCAL_STORAGE_NOTES_KEY);
    console.log(`[VoiceNotesApp] loadNotes: Attempting to load notes from localStorage. Has saved notes: ${!!savedNotes}`);
    if (savedNotes) {
        try {
            let parsedNotes = JSON.parse(savedNotes);
            if (!Array.isArray(parsedNotes)) {
                 console.warn("[VoiceNotesApp] loadNotes: Loaded notes data is not an array. Resetting notes.");
                 this.notes = [];
            } else {
                console.log(`[VoiceNotesApp] loadNotes: Parsed ${parsedNotes.length} notes from localStorage.`);
                this.notes = parsedNotes.map((note: any, index: number) => {
                    const id = (typeof note.id === 'string' && note.id.length > 0) ? note.id : `legacy_note_${Date.now()}_${index}`;
                    const title = (typeof note.title === 'string') ? note.title : 'Untitled Note';
                    const rawTranscription = (typeof note.rawTranscription === 'string') ? note.rawTranscription : '';
                    const polishedNote = (typeof note.polishedNote === 'string') ? note.polishedNote : '';
                    const timestamp = (typeof note.timestamp === 'number' && !isNaN(note.timestamp)) ? note.timestamp : 0; 

                    if (id !== note.id || title !== note.title || timestamp !== note.timestamp || rawTranscription !== note.rawTranscription || polishedNote !== note.polishedNote) {
                        console.warn('[VoiceNotesApp] loadNotes: Corrected malformed note during load:', { original: note, corrected: {id, title, timestamp, rawTranscriptionLength: rawTranscription.length, polishedNoteLength: polishedNote.length} });
                    }
                    return { id, title, rawTranscription, polishedNote, timestamp };
                });
            }
            this.notes.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
            console.log(`[VoiceNotesApp] loadNotes: Notes sorted. Total notes loaded: ${this.notes.length}`);
        } catch (e) {
            console.error("[VoiceNotesApp] loadNotes: Error parsing notes from localStorage:", e);
            this.notes = []; 
            try {
                localStorage.removeItem(LOCAL_STORAGE_NOTES_KEY); 
            } catch (removeError) {
                 console.error("[VoiceNotesApp] loadNotes: Error removing corrupted notes key from localStorage:", removeError);
            }
        }
    } else {
        this.notes = []; 
        console.log("[VoiceNotesApp] loadNotes: No saved notes found in localStorage. Initialized with empty notes array.");
    }
    this.renderNoteList(); 
  }

  private saveNotes(): void {
    try {
      this.notes.sort((a,b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
      localStorage.setItem(LOCAL_STORAGE_NOTES_KEY, JSON.stringify(this.notes));
      console.log(`[VoiceNotesApp] saveNotes: Saved ${this.notes.length} notes to localStorage. Current note ID: ${this.currentNoteId}`);
    } catch (error) {
      console.error("[VoiceNotesApp] saveNotes: Error saving notes to localStorage:", error);
      this.recordingStatus.textContent = "Warning: Could not save notes. Storage might be full or restricted.";
    }
  }

  private renderNoteList(): void {
    console.log(`[VoiceNotesApp] renderNoteList called. Total notes: ${this.notes.length}. Current selected ID: ${this.currentNoteId}`);
    this.noteListElement.innerHTML = ''; 
    if (this.notes.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No notes yet.';
        li.style.padding = '12px 20px';
        li.style.color = 'var(--color-text-tertiary)';
        this.noteListElement.appendChild(li);
        this.exportNoteButton.disabled = true; 
        console.log("[VoiceNotesApp] renderNoteList: Rendered 'No notes yet.' message.");
        return;
    }
    this.exportNoteButton.disabled = !this.currentNoteId || !this.notes.find(n=>n.id === this.currentNoteId);


    this.notes.forEach(note => {
        const li = document.createElement('li');
        li.className = 'note-list-item';
        li.setAttribute('data-note-id', note.id);
        if (note.id === this.currentNoteId) {
            li.classList.add('active');
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'note-item-content';

        const titleEl = document.createElement('div');
        titleEl.className = 'note-item-title';
        titleEl.textContent = note.title || 'Untitled Note';
        
        const timestampEl = document.createElement('div');
        timestampEl.className = 'note-item-timestamp';
        const timestamp = (typeof note.timestamp === 'number' && !isNaN(note.timestamp)) ? note.timestamp : 0;
        timestampEl.textContent = new Date(timestamp).toLocaleString();


        contentDiv.appendChild(titleEl);
        contentDiv.appendChild(timestampEl);
        li.appendChild(contentDiv);

        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-note-button';
        deleteButton.innerHTML = '<i class="fas fa-times"></i>';
        deleteButton.title = 'Delete Note';
        deleteButton.setAttribute('aria-label', 'Delete note ' + (note.title || 'Untitled Note'));
        deleteButton.onclick = (e) => {
            e.stopPropagation(); 
            this.deleteNote(note.id);
        };
        li.appendChild(deleteButton);

        li.onclick = () => {
          if (!this.isRecording) {
            if (this.currentNoteId !== note.id) { 
                this.selectNote(note.id);
            }
          } else {
            alert("Please stop recording before switching notes.");
          }
        };
        this.noteListElement.appendChild(li);
    });
    // console.log("[VoiceNotesApp] renderNoteList: List fully rendered.");
  }

  private exportCurrentNote(): void {
    if (!this.currentNoteId) {
        alert('No note selected to export.');
        return;
    }
    const currentNote = this.notes.find(n => n.id === this.currentNoteId);
    if (!currentNote) {
        alert('Selected note not found. Cannot export.');
        return;
    }
    if (!currentNote.polishedNote || !currentNote.polishedNote.trim()) {
        if (!currentNote.rawTranscription || !currentNote.rawTranscription.trim()) {
            alert('Note is empty. Nothing to export.');
            return;
        }
        if (!confirm("Polished note is empty. Export raw transcription instead?")) {
            return;
        }
        const rawFilename = `${(currentNote.title || 'untitled_note').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_raw.txt`;
        const rawBlob = new Blob([currentNote.rawTranscription], { type: 'text/plain;charset=utf-8' });
        this.downloadBlob(rawBlob, rawFilename);
        this.recordingStatus.textContent = 'Raw transcription exported.';
        return;
    }

    const filename = `${(currentNote.title || 'untitled_note').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
    const blob = new Blob([currentNote.polishedNote], { type: 'text/markdown;charset=utf-8' });
    this.downloadBlob(blob, filename);
    this.recordingStatus.textContent = 'Polished note exported.';
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private handleClearAllNotes(): void {
    console.log(`[VoiceNotesApp] handleClearAllNotes called. Current notes count: ${this.notes.length}`);
    if (this.isRecording) {
        alert("Please stop recording before clearing all notes.");
        console.log("[VoiceNotesApp] handleClearAllNotes: Aborted, recording in progress.");
        return;
    }
    if (!confirm('Are you sure you want to delete ALL notes? This action cannot be undone.')) {
        console.log("[VoiceNotesApp] handleClearAllNotes: User cancelled operation.");
        return;
    }
    console.log("[VoiceNotesApp] handleClearAllNotes: User confirmed operation.");

    this.notes = [];
    this.currentNoteId = null;
    console.log("[VoiceNotesApp] handleClearAllNotes: In-memory notes array cleared and currentNoteId set to null.");

    try {
        localStorage.removeItem(LOCAL_STORAGE_NOTES_KEY);
        localStorage.removeItem(LOCAL_STORAGE_LAST_NOTE_ID_KEY);
        console.log("[VoiceNotesApp] handleClearAllNotes: Removed notes and last note ID from localStorage.");
    } catch (error) {
        console.error("[VoiceNotesApp] handleClearAllNotes: Error clearing notes from localStorage:", error);
        this.recordingStatus.textContent = "Warning: Could not clear all note data from storage.";
    }
    
    this.createNewNote(true); 
    this.recordingStatus.textContent = 'All notes cleared.';
    console.log("[VoiceNotesApp] handleClearAllNotes: Operation completed. A new initial note has been created.");
  }

}

document.addEventListener('DOMContentLoaded', () => {
  new VoiceNotesApp();
});

export {};