//page.tsx
'use client';

import React, { useState } from 'react';
import { Upload, Download, Play, AlertCircle, CheckCircle, Loader, ChevronDown, ChevronRight, Filter } from 'lucide-react';
import SettingsTab from '@/components/SettingsTab';
import SplitterTab from '@/components/SplitterTab';
import { normalizeOwnerNameString } from '@/lib/owner-name-normalizer';

interface BusinessResult {
  stadt: string;
  branche: string;
  name?: string;
  telefon?: string;
  website?: string;
  email?: string;
  owner?: string;
  ownerSalutations?: string;
  ownerFirstNames?: string;
  ownerLastNames?: string;
  status?: string;
  rating?: number;
  reviews?: number;
  hours?: string;
  price?: string;
}

type Language = 'de' | 'en';

const translations = {
  de: {
    title: 'Local Business Scraper',
    subtitle: 'Scrape Tausende lokale Unternehmen nach Stadt und Branche.',
    uploadLabel: 'Excel- oder CSV-Datei hochladen mit den Spalten "Stadt" und "Branche" (optionale Spalte "Max" überschreibt die maximale Anzahl pro Zeile):',
    uploadPlaceholder: 'Zum Hochladen klicken oder Datei hier ablegen',
    uploadError: 'Bitte nur Excel- oder CSV-Dateien hochladen',
    settings: 'Einstellungen',
    searchEmail: 'Email-Adressen suchen',
    searchOwner: 'Geschäftsführer suchen',
    country: 'Land',
    maxBusinesses: 'Maximale Unternehmen pro Suche',
    minPrice: 'Mindestpreis (€)',
    maxPrice: 'Höchstpreis (€)',
    startButton: 'Scraping starten',
    cancelButton: 'Abbrechen',
    processing: 'Verarbeitung läuft...',
    leads: 'Leads',
    results: 'Ergebnisse',
    download: 'CSV Download',
    downloadAll: 'Alle (CSV)',
    downloadSplit: 'Aufgeteilt (Excel)',
    city: 'Stadt',
    industry: 'Branche',
    name: 'Name',
    email: 'Email',
    owner: 'Geschäftsführer',
    status: 'Status',
    rating: 'Bewertung',
    reviews: 'Anzahl Bewertungen',
    hours: 'Öffnungszeiten',
    price: 'Preis',
    phone: 'Telefon',
    website: 'Website',
    howItWorks: 'So funktioniert es:',
    step1: 'Excel- oder CSV-Datei mit den Spalten "Stadt" und "Branche" hochladen (optionale Spalte "Max" pro Zeile möglich)',
    step2: 'Einen Kaffee holen',
    step3: 'Ergebnisse als CSV herunterladen',
    fileRequired: 'Bitte laden Sie zuerst eine Datei hoch',
    scrapingFailed: 'Scraping fehlgeschlagen',
    errorOccurred: 'Ein Fehler ist aufgetreten',
    run: 'Durchlauf',
    of: 'von',
  },
  en: {
    title: 'Local Business Scraper',
    subtitle: 'Scrape thousands of local businesses by city and industry.',
    uploadLabel: 'Upload Excel or CSV File with the columns "city" and "industry" (optional column "max" overrides the maximum per row):',
    uploadPlaceholder: 'Click to upload or drag file here',
    uploadError: 'Please upload only Excel or CSV files',
    settings: 'Settings',
    searchEmail: 'Search for emails',
    searchOwner: 'Search for business owners',
    country: 'Country',
    maxBusinesses: 'Max businesses per search',
    minPrice: 'Min Price (€)',
    maxPrice: 'Max Price (€)',
    startButton: 'Start Scraping',
    cancelButton: 'Cancel',
    processing: 'Processing...',
    leads: 'Leads',
    results: 'Results',
    download: 'CSV Download',
    downloadAll: 'All (CSV)',
    downloadSplit: 'Split (Excel)',
    city: 'City',
    industry: 'Industry',
    name: 'Name',
    email: 'Email',
    owner: 'Owner',
    status: 'Status',
    rating: 'Rating',
    reviews: 'Reviews',
    hours: 'Opening Hours',
    price: 'Price',
    phone: 'Phone',
    website: 'Website',
    howItWorks: 'How it works:',
    step1: 'Upload Excel or CSV file with columns "city" and "industry" (optional "max" column per row supported)',
    step2: 'Get a coffee',
    step3: 'Download results as CSV',
    fileRequired: 'Please upload a file first',
    scrapingFailed: 'Scraping failed',
    errorOccurred: 'An error occurred',
    run: 'Run',
    of: 'of'
  },
};

const countries = [
  { code: 'de', name: 'Germany / Deutschland' },
  { code: 'at', name: 'Austria / Österreich' },
  { code: 'ch', name: 'Switzerland / Schweiz' },
  { code: 'us', name: 'United States' },
  { code: 'uk', name: 'United Kingdom' },
  { code: 'fr', name: 'France' },
  { code: 'it', name: 'Italy / Italia' },
  { code: 'es', name: 'Spain / España' },
  { code: 'nl', name: 'Netherlands' },
  { code: 'be', name: 'Belgium' },
  { code: 'pl', name: 'Poland / Polska' },
  { code: 'other', name: 'Other' },
];

export default function BusinessScraper() {
  const [file, setFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [progress, setProgress] = useState({ 
    current: 0, 
    total: 0, 
    status: '', 
    searchCount: 0, 
    totalSearches: 0 
  });
  const [results, setResults] = useState<BusinessResult[] | null>(null);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [language, setLanguage] = useState<Language>('de');
  const [searchEmail, setSearchEmail] = useState(true);
  const [singleWorker, setSingleWorker] = useState(false);
  const [searchOwner, setSearchOwner] = useState(true);
  const [country, setCountry] = useState('de');
  const [maxBusinesses, setMaxBusinesses] = useState<number | 'max' | ''>(60);
  const [minPrice, setMinPrice] = useState<number | ''>('');
  const [maxPrice, setMaxPrice] = useState<number | ''>('');
  const [categoryWhitelist, setCategoryWhitelist] = useState('');
  const [categoryBlacklist, setCategoryBlacklist] = useState('');
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [enrichmentWorkerCount, setEnrichmentWorkerCount] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resumeSessionId, setResumeSessionId] = useState('');
  const [blockedInfo, setBlockedInfo] = useState<{ level: number; label: string; message: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'scraper' | 'history' | 'settings' | 'splitter'>('scraper');
  const [history, setHistory] = useState<any[]>([]);

  const [autoScroll, setAutoScroll] = useState(true);
  const tableContainerRef = React.useRef<HTMLDivElement>(null);
  // Tracks whether connection dropped mid-session (sleep/disconnect) vs user-cancelled
  const [sessionDropped, setSessionDropped] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  // Refs so event listeners always see current values
  const sessionIdRef = React.useRef<string | null>(null);
  const processingRef = React.useRef(false);
  const userCancelledRef = React.useRef(false);

  React.useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  React.useEffect(() => { processingRef.current = processing; }, [processing]);

  // Cancel on actual page unload (tab close, navigation, Electron window close).
  // Does NOT fire on sleep/minimize – enrichment keeps running in that case.
  React.useEffect(() => {
    const handlePageHide = (e: PageTransitionEvent) => {
      if (!e.persisted && processingRef.current && sessionIdRef.current) {
        navigator.sendBeacon(
          '/api/scrape/cancel',
          JSON.stringify({ sessionId: sessionIdRef.current }),
        );
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  React.useEffect(() => {
    if (autoScroll && tableContainerRef.current) {
      const container = tableContainerRef.current;
      container.scrollTop = container.scrollHeight;
    }
  }, [results, autoScroll]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const isAtBottom = Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) < 10;
    setAutoScroll(isAtBottom);
  };

  const t = translations[language];

  // Detect browser language after component mounts (client-side only)
  React.useEffect(() => {
    const browserLang = navigator.language.toLowerCase();
    const detectedLang = browserLang.startsWith('de') ? 'de' : 'en';
    setLanguage(detectedLang);
  }, []);

  React.useEffect(() => {
    if (activeTab === 'history') {
      fetch('/api/history')
        .then(res => res.json())
        .then(data => {
            if (Array.isArray(data)) setHistory(data);
        })
        .catch(console.error);
    }
  }, [activeTab]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (uploadedFile) {
      setFile(uploadedFile);
      setError('');
      setResults(null);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile && (droppedFile.name.endsWith('.xlsx') || droppedFile.name.endsWith('.xls') || droppedFile.name.endsWith('.csv'))) {
      setFile(droppedFile);
      setError('');
      setResults(null);
    } else {
      setError(t.uploadError);
    }
  };

  const startScraping = async () => {
    if (!file) {
      setError(t.fileRequired);
      return;
    }

    setProcessing(true);
    setError('');
    setResults(null);
    setSessionId(null);
    setBlockedInfo(null);
    setSessionDropped(false);
    userCancelledRef.current = false;
    setProgress({ current: 0, total: 0, status: 'Starte...', searchCount: 0, totalSearches: 0 });

    const controller = new AbortController();
    setAbortController(controller);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('searchEmail', String(searchEmail));
    formData.append('singleWorker', String(singleWorker));
    formData.append('searchOwner', String(searchOwner));
    formData.append('country', country);
    formData.append('maxBusinesses', String(!maxBusinesses ? 20 : (maxBusinesses === 'max' ? 100000 : maxBusinesses)));
    if (minPrice !== '') formData.append('minPrice', String(minPrice));
    if (maxPrice !== '') formData.append('maxPrice', String(maxPrice));
    formData.append('categoryWhitelist', categoryWhitelist);
    formData.append('categoryBlacklist', categoryBlacklist);
    formData.append('enrichmentWorkerCount', String(enrichmentWorkerCount));

    const tempResults: BusinessResult[] = [];
    let receivedComplete = false;

    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(t.scrapingFailed);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) {
        throw new Error('Stream nicht verfügbar');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.type === 'session') {
                setSessionId(data.sessionId);
              } else if (data.type === 'progress') {
                setProgress({
                  current: data.current,
                  total: data.total,
                  status: data.message,
                  searchCount: data.searchCount,
                  totalSearches: data.totalSearches,
                });
              } else if (data.type === 'result') {
                tempResults.push(data.result);
                setResults([...tempResults]);
              } else if (data.type === 'complete') {
                receivedComplete = true;
                // Results already accumulated via individual 'result' events – no need to re-send the full array
                setResults([...tempResults]);
                setProgress({
                  current: tempResults.length,
                  total: tempResults.length,
                  status: data.message,
                  searchCount: 0,
                  totalSearches: 0,
                });
              } else if (data.type === 'error') {
                setError(data.message);
              } else if (data.type === 'blocked') {
                setBlockedInfo({
                  level: data.level,
                  label: data.label ?? `Level ${data.level}`,
                  message: data.message,
                });
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (!userCancelledRef.current && !receivedComplete) {
          // Connection dropped (sleep/disconnect) but user didn't press cancel.
          // Enrichment keeps running on the server – show reconnect hint.
          setSessionDropped(true);
        }
        setResults([...tempResults]);
      } else {
        setError(err instanceof Error ? err.message : t.errorOccurred);
      }
    } finally {
      setProcessing(false);
      setAbortController(null);
    }
  };

  const loadSnapshot = async () => {
    if (!sessionId || snapshotLoading) return;
    setSnapshotLoading(true);
    try {
      const res = await fetch(`/api/scrape/snapshot?session=${sessionId}`);
      if (!res.ok) { setError('Snapshot konnte nicht geladen werden.'); return; }
      const data = await res.json();
      setResults(data.results);
      if (!data.stillRunning) {
        setSessionDropped(false);
        setProgress(p => ({ ...p, status: language === 'de' ? '✅ Enrichment abgeschlossen' : '✅ Enrichment complete', current: data.results.length, total: data.results.length }));
      } else {
        setProgress(p => ({ ...p, status: language === 'de' ? `⏳ Noch ${data.results.filter((r: any) => r.status === 'pending' || r.status === 'enriching').length} ausstehend…` : `⏳ Still enriching…`, current: data.results.filter((r: any) => r.status !== 'pending' && r.status !== 'enriching').length, total: data.results.length }));
      }
    } catch {
      setError('Snapshot konnte nicht geladen werden.');
    } finally {
      setSnapshotLoading(false);
    }
  };

  const cancelScraping = () => {
    userCancelledRef.current = true;
    // Tell the server to mark the session as cancelled in the DB (stops enrichment workers).
    if (sessionId) {
      fetch('/api/scrape/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }
    // Abort the SSE stream so the client stops receiving events.
    if (abortController) {
      abortController.abort();
    }
  };

  const downloadResults = () => {
    if (!results) return;

    const csv = [
      [
        t.city,
        t.industry,
        t.name,
        t.price,
        t.phone,
        t.website,
        t.email,
        'Anrede',
        `${t.owner} Vorname`,
        `${t.owner} Nachname`,
        t.owner,
        t.rating,
        t.reviews,
        t.hours,
        t.status,
      ].join(','),
      ...results.map((r: BusinessResult) => {
        const fallback = normalizeOwnerNameString(r.owner);
        const ownerSalutations = r.ownerSalutations ?? fallback.ownerSalutations ?? '';
        const ownerFirstNames = r.ownerFirstNames ?? fallback.ownerFirstNames ?? '';
        const ownerLastNames = r.ownerLastNames ?? fallback.ownerLastNames ?? '';

        return [
          r.stadt,
          r.branche,
          r.name || '',
          r.price || '',
          r.telefon || '',
          r.website || '',
          r.email || '',
          ownerSalutations,
          ownerFirstNames,
          ownerLastNames,
          r.owner || '',
          r.rating?.toString() || '',
          r.reviews?.toString() || '',
          r.hours || '',
          r.status || ''
        ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
      })
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `scraping_ergebnisse_${Date.now()}.csv`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100 p-8">
      <div className="w-full max-w-[95%] mx-auto">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="flex justify-between items-start mb-2">
            <h1 className="text-3xl font-bold text-gray-800">{t.title}</h1>
            <div className="flex gap-2">
              <button
                onClick={() => setLanguage('de')}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  language === 'de' ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                DE
              </button>
              <button
                onClick={() => setLanguage('en')}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  language === 'en' ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                EN
              </button>
            </div>
          </div>
          <p className="text-gray-600 mb-8">
            {t.subtitle}
          </p>

          <div className="flex border-b border-gray-200 mb-8">
            <button
              onClick={() => setActiveTab('scraper')}
              className={`py-2 px-4 font-medium text-sm transition-colors relative ${
                activeTab === 'scraper' 
                  ? 'text-indigo-600 border-b-2 border-indigo-600' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Scraper
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`py-2 px-4 font-medium text-sm transition-colors relative ${
                activeTab === 'history' 
                  ? 'text-indigo-600 border-b-2 border-indigo-600' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              History
            </button>
            <button
              onClick={() => setActiveTab('splitter')}
              className={`py-2 px-4 font-medium text-sm transition-colors relative ${
                activeTab === 'splitter' 
                  ? 'text-indigo-600 border-b-2 border-indigo-600' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Splitter
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`py-2 px-4 font-medium text-sm transition-colors relative ${
                activeTab === 'settings' 
                  ? 'text-indigo-600 border-b-2 border-indigo-600' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.settings}
            </button>
          </div>

          {activeTab === 'scraper' && (
            <>
          {/* Upload Section */}
          <div className="mb-8">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t.uploadLabel}
            </label>
            <div 
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                isDragging 
                  ? 'border-indigo-500 bg-indigo-50' 
                  : 'border-gray-300 hover:border-indigo-500'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="mx-auto h-12 w-12 text-gray-400 mb-2" />
                <p className="text-sm text-gray-600">
                  {file ? file.name : t.uploadPlaceholder}
                </p>
                <p className="text-xs text-gray-500 mt-1">XLSX, XLS or CSV</p>
              </label>
            </div>
          </div>


          {/* Settings Section */}
          <div className="mb-8 p-6 bg-gray-50 rounded-lg border border-gray-200">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">{t.settings}</h3>
            
            <div className="space-y-4">
              {/* Email Toggle */}
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">{t.searchEmail}</label>
                <button
                  onClick={() => setSearchEmail(!searchEmail)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    searchEmail ? 'bg-indigo-600' : 'bg-gray-300'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      searchEmail ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Owner Toggle */}
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">{t.searchOwner}</label>
                <button
                  onClick={() => setSearchOwner(!searchOwner)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    searchOwner ? 'bg-indigo-600' : 'bg-gray-300'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      searchOwner ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Country Selection - Only visible when searching for owners */}
              {searchOwner && (
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-gray-700">{t.country}</label>
                  <select
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Max Businesses */}
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">{t.maxBusinesses}</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="0"
                    step="20"
                    value={maxBusinesses === 'max' ? '' : maxBusinesses}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === '') {
                        setMaxBusinesses('');
                      } else {
                        setMaxBusinesses(parseInt(value) || '');
                      }
                    }}
                    className={`w-24 px-3 py-2 border rounded-lg text-sm transition-colors ${
                      maxBusinesses === 'max' 
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium placeholder-indigo-400' 
                        : 'border-gray-300'
                    }`}
                    placeholder={maxBusinesses === 'max' ? 'Max' : "20, 60..."}
                  />
                  <button
                    onClick={() => setMaxBusinesses(maxBusinesses === 'max' ? 60 : 'max')}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      maxBusinesses === 'max'
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : 'bg-gray-300 text-gray-700 hover:bg-gray-400'
                    }`}
                  >
                    Max
                  </button>
                </div>
              </div>

              {/* Price Filter Collapsible */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setIsFiltersOpen(!isFiltersOpen)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                    <Filter className="w-4 h-4" />
                    <span>Filter</span>
                    {(minPrice !== '' || maxPrice !== '' || categoryWhitelist !== '' || categoryBlacklist !== '') && (
                      <span className="w-2 h-2 rounded-full bg-blue-500 ml-1"></span>
                    )}
                  </div>
                  {isFiltersOpen ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                </button>
                
                {isFiltersOpen && (
                  <div className="p-4 space-y-4 bg-white border-t border-gray-200">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-gray-700">{t.minPrice}</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={minPrice}
                        onChange={(e) => setMinPrice(e.target.value === '' ? '' : parseInt(e.target.value))}
                        className="w-24 px-3 py-2 border rounded-lg text-sm border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="z.B. 10"
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-gray-700">{t.maxPrice}</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={maxPrice}
                        onChange={(e) => setMaxPrice(e.target.value === '' ? '' : parseInt(e.target.value))}
                        className="w-24 px-3 py-2 border rounded-lg text-sm border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="z.B. 50"
                      />
                    </div>
                    <div className="pt-2 border-t border-gray-100">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Kategorien Whitelist (kommagetrennt)
                      </label>
                      <textarea
                        value={categoryWhitelist}
                        onChange={(e) => setCategoryWhitelist(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="z.B. Webdesign-Agentur, Marketingberater"
                        rows={2}
                      />
                      <p className="mt-1 text-xs text-gray-500">Wenn nicht leer, werden NUR diese Kategorien zugelassen.</p>
                    </div>
                    <div className="pt-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Kategorien Blacklist (kommagetrennt)
                      </label>
                      <textarea
                        value={categoryBlacklist}
                        onChange={(e) => setCategoryBlacklist(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="z.B. Imbiss, Zahnarzt"
                        rows={2}
                      />
                      <p className="mt-1 text-xs text-gray-500">Wenn enthalten, werden diese Kategorien ignoriert (z.B. "imbiss" blockiert auch "Kebabimbiss").</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Start Button */}
          <div className="flex gap-4">
            <button
              onClick={startScraping}
              disabled={!file || processing}
              className="flex-1 bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
            >
             {processing ? (
                <>
                  <Loader className="animate-spin mr-2" />
                  {t.processing}
                </>
              ) : (
                <>
                  <Play className="mr-2" />
                  {t.startButton}
                </>
              )}
            </button>
            
            {processing && (
              <button
                onClick={cancelScraping}
                className="bg-red-500 text-white py-3 px-6 rounded-lg font-semibold hover:bg-red-600 transition-colors flex items-center justify-center"
              >
                  <AlertCircle className="mr-2" />
                  {t.cancelButton}
              </button>
            )}
          </div>

          {/* Resume Section */}
          {!processing && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Session fortsetzen</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={resumeSessionId}
                  onChange={e => setResumeSessionId(e.target.value)}
                  placeholder="Session-ID eingeben..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={async () => {
                    if (!resumeSessionId.trim()) return;
                    setProcessing(true);
                    setError('');
                    setSessionId(resumeSessionId.trim());
                    setProgress({ current: 0, total: 0, status: 'Resuming...', searchCount: 0, totalSearches: 0 });
                    const controller = new AbortController();
                    setAbortController(controller);
                    const tempResults: BusinessResult[] = [];
                    setResults([]);

                    try {
                      const response = await fetch(`/api/resume?session=${resumeSessionId.trim()}`, {
                        signal: controller.signal,
                      });
                      const reader = response.body?.getReader();
                      const decoder = new TextDecoder();
                      if (!reader) return;
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const lines = decoder.decode(value).split('\n');
                        for (const line of lines) {
                          if (!line.startsWith('data: ')) continue;
                          try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'progress') setProgress({ current: data.current, total: data.total, status: data.message, searchCount: data.searchCount ?? 0, totalSearches: data.totalSearches ?? 0 });
                            else if (data.type === 'result') { tempResults.push(data.result); setResults([...tempResults]); }
                            else if (data.type === 'complete') setResults([...tempResults]);
                            else if (data.type === 'error') setError(data.message);
                          } catch {}
                        }
                      }
                    } catch (err) {
                      if ((err as Error).name === 'AbortError') { setResults([...tempResults]); }
                      else { setError(err instanceof Error ? err.message : 'Error'); }
                    } finally {
                      setProcessing(false);
                      setAbortController(null);
                    }
                  }}
                  disabled={!resumeSessionId.trim() || processing}
                  className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-semibold hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  Resume
                </button>
              </div>
            </div>
          )}

          {/* Progress */}
          {processing && (
            <div className="mt-6 p-4 bg-indigo-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-indigo-900">{progress.status}</span>
                <div className="text-right">
                  <div className="text-sm font-semibold text-indigo-700">
                    {progress.current} / {progress.total} {t.leads} ({progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%)
                  </div>
                  {progress.totalSearches > 0 && (
                    <div className="text-xs text-indigo-600 mt-1">
                      {t.run} {progress.searchCount} {t.of} {progress.totalSearches}
                    </div>
                  )}
                </div>
              </div>
              <div className="w-full bg-indigo-200 rounded-full h-2">
                <div
                  className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
              {sessionId && (
                <div className="mt-3 flex items-center gap-2 text-xs text-indigo-700">
                  <span className="font-medium">Session-ID:</span>
                  <code className="bg-indigo-100 px-2 py-0.5 rounded font-mono">{sessionId}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(sessionId)}
                    className="text-indigo-500 hover:text-indigo-700 underline"
                  >
                    Kopieren
                  </button>
                  <span className="text-indigo-400">(bei Abbruch damit fortsetzen)</span>
                </div>
              )}
            </div>
          )}

          {/* Connection-dropped banner (sleep / network disconnect) */}
          {sessionDropped && (
            <div className="mt-4 p-4 rounded-lg border bg-blue-50 border-blue-300 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-semibold text-blue-900">
                  {language === 'de' ? '📡 Verbindung unterbrochen' : '📡 Connection lost'}
                </p>
                <p className="text-sm text-blue-800 mt-1">
                  {language === 'de'
                    ? 'Das Enrichment läuft im Hintergrund weiter. Klicke auf „Aktualisieren" um den aktuellen Stand zu laden.'
                    : 'Enrichment continues in the background. Click "Reload" to fetch the current state.'}
                </p>
                {sessionId && (
                  <p className="text-xs text-blue-600 mt-1 font-mono">Session: {sessionId}</p>
                )}
                <div className="mt-2 flex gap-3 items-center flex-wrap">
                  <button
                    onClick={loadSnapshot}
                    disabled={snapshotLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {snapshotLoading
                      ? <Loader className="h-3.5 w-3.5 animate-spin" />
                      : <span>🔄</span>}
                    {language === 'de' ? 'Aktualisieren' : 'Reload'}
                  </button>
                  <button
                    onClick={() => setActiveTab('history')}
                    className="text-sm text-blue-700 underline hover:text-blue-900"
                  >
                    {language === 'de' ? 'Verlauf öffnen →' : 'Open History →'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Blocked Banner */}
          {blockedInfo && (
            <div className={`mt-6 p-4 rounded-lg border flex items-start gap-3 ${
              processing
                ? 'bg-orange-50 border-orange-300'
                : 'bg-yellow-50 border-yellow-300'
            }`}>
              <AlertCircle className="h-5 w-5 text-orange-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-semibold text-orange-900">
                  {language === 'de'
                    ? `⚠️ Temporär von Google gesperrt`
                    : `⚠️ Temporarily blocked by Google`}
                  {' '}
                  <span className="text-orange-600 font-normal text-sm">
                    ({blockedInfo.label})
                  </span>
                </p>
                <p className="text-sm text-orange-800 mt-1">
                  {language === 'de'
                    ? 'Google Maps Scraping wurde pausiert. Bereits gefundene Ergebnisse bleiben erhalten.'
                    : 'Google Maps scraping has been paused. Results collected so far are preserved.'}
                </p>
                {processing && (
                  <p className="text-xs text-orange-600 mt-1 italic">
                    {language === 'de'
                      ? '⏳ Email-Enrichment läuft noch für bereits gescrapte Einträge...'
                      : '⏳ Email enrichment is still running for already-scraped entries...'}
                  </p>
                )}
                <p className="text-xs text-orange-500 mt-2 font-mono break-all">{blockedInfo.message}</p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-6 p-4 bg-red-50 rounded-lg border border-red-200">
              <p className="text-red-800 flex items-center">
                <AlertCircle className="w-5 h-5 mr-2" />
                {error}
              </p>
            </div>
          )}

          {/* Results */}
          {results && (
            <div className="mt-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-800 flex items-center">
                  <CheckCircle className="w-6 h-6 mr-2 text-green-500" />
                  {t.results} ({results.length})
                </h2>
                <div className="flex gap-2">
                  <button
                    onClick={downloadResults}
                    className="bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition-colors flex items-center text-sm"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    {t.downloadAll}
                  </button>
                  {sessionId && (
                    <div className="relative group inline-block">
                      <button className="bg-indigo-600 text-white py-2 px-4 rounded-lg hover:bg-indigo-700 transition-colors flex items-center text-sm">
                        <Download className="w-4 h-4 mr-2" />
                        {t.downloadSplit}
                        <ChevronDown className="w-4 h-4 ml-1" />
                      </button>
                      <div className="absolute right-0 mt-1 w-40 bg-white border border-gray-200 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                        <a
                          href={`/api/history/${sessionId}/download?split=true&format=excel`}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded-t-lg"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Excel (.xlsx)
                        </a>
                        <a
                          href={`/api/history/${sessionId}/download?split=true&format=zip`}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded-b-lg border-t border-gray-100"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          CSV (ZIP)
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              <div 
                className="overflow-auto max-h-[60vh] border rounded-lg"
                ref={tableContainerRef}
                onScroll={handleScroll}
              >
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold">{t.city}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.industry}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.name}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.price}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.phone}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.website}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.rating}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.hours}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.email}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.owner}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r: BusinessResult, i: number) => (
                      <tr key={i} className="border-t hover:bg-gray-50">
                        <td className="px-4 py-2">{r.stadt}</td>
                        <td className="px-4 py-2">{r.branche}</td>
                        <td className="px-4 py-2">{r.name || '-'}</td>
                        <td className="px-4 py-2">{r.price || '-'}</td>
                        <td className="px-4 py-2">{r.telefon || '-'}</td>
                        <td className="px-4 py-2">
                          {r.website ? (
                            <a href={r.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                              Website
                            </a>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-2">
                          {r.rating ? (
                            <div className="flex items-center gap-1">
                              <span className="text-yellow-600">⭐</span>
                              <span className="font-medium">{r.rating.toFixed(1)}</span>
                              {r.reviews && <span className="text-gray-500 text-xs">({r.reviews})</span>}
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2 max-w-xs">
                          {r.hours ? (
                            <span className="text-sm text-gray-700" title={r.hours}>
                              {r.hours.length > 50 ? r.hours.substring(0, 50) + '...' : r.hours}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {r.email ? (
                            <span className="text-green-600 font-medium">{r.email}</span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                         <td className="px-4 py-2">
                          {r.owner ? (
                            <span className="text-blue-600 font-medium">{r.owner}</span>
                          ) : (
                             <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-xs px-2 py-1 rounded ${
                            r.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                          }`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Instructions */}
          <div className="mt-8 p-4 bg-gray-50 rounded-lg text-sm text-gray-600">
            <h3 className="font-semibold text-gray-800 mb-2">{t.howItWorks}</h3>
            <ol className="list-decimal list-inside space-y-1">
              <li>{t.step1}</li>
              <li>{t.step2}</li>
              <li>{t.step3}</li>
            </ol>
          </div>
          </>
          )}

          {activeTab === 'history' && (
            <div className="space-y-4">
               {history.length === 0 ? (
                 <p className="text-gray-500 text-center py-8">Keine Scrape-Historie gefunden.</p>
               ) : (
                 <div className="overflow-x-auto">
                   <table className="w-full text-sm text-left border rounded-lg">
                     <thead className="text-xs text-gray-700 uppercase bg-gray-50 border-b">
                       <tr>
                         <th className="px-6 py-3">Datum</th>
                         <th className="px-6 py-3">Session ID</th>
                         <th className="px-6 py-3">Status</th>
                         <th className="px-6 py-3">Jobs</th>
                         <th className="px-6 py-3">Aktion</th>
                       </tr>
                     </thead>
                     <tbody>
                       {history.map((session) => (
                         <tr key={session.id} className="bg-white border-b hover:bg-gray-50 last:border-b-0">
                           <td className="px-6 py-4">
                             {new Date(session.created_at).toLocaleString()}
                           </td>
                            <td className="px-6 py-4 font-mono text-xs text-gray-500">
                             {session.id}
                           </td>
                           <td className="px-6 py-4">
                             <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                               session.status === 'active' ? 'bg-blue-100 text-blue-800' :
                               session.status === 'done' ? 'bg-green-100 text-green-800' :
                               'bg-gray-100 text-gray-800'
                             }`}>
                               {session.status}
                             </span>
                           </td>
                           <td className="px-6 py-4 text-gray-600">
                             {session.total_jobs}
                           </td>
                           <td className="px-6 py-4">
                             <div className="flex flex-col gap-1">
                               <a
                                 href={`/api/history/${session.id}/download`}
                                 className="font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1 whitespace-nowrap"
                                 target="_blank"
                                 rel="noopener noreferrer"
                               >
                                 <Download className="w-4 h-4" /> CSV
                               </a>
                               <div className="relative group inline-block">
                                 <button className="font-medium text-green-600 hover:text-green-800 flex items-center gap-1 whitespace-nowrap">
                                   <Download className="w-4 h-4" /> Aufgeteilt
                                   <ChevronDown className="w-3 h-3" />
                                 </button>
                                 <div className="absolute left-0 mt-1 w-32 bg-white border border-gray-200 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                                   <a
                                     href={`/api/history/${session.id}/download?split=true&format=excel`}
                                     className="block px-3 py-2 text-xs text-gray-700 hover:bg-green-50 hover:text-green-700 rounded-t-lg"
                                     target="_blank"
                                     rel="noopener noreferrer"
                                   >
                                     Excel (.xlsx)
                                   </a>
                                   <a
                                     href={`/api/history/${session.id}/download?split=true&format=zip`}
                                     className="block px-3 py-2 text-xs text-gray-700 hover:bg-green-50 hover:text-green-700 rounded-b-lg border-t border-gray-100"
                                     target="_blank"
                                     rel="noopener noreferrer"
                                   >
                                     CSV (ZIP)
                                   </a>
                                 </div>
                               </div>
                             </div>
                           </td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               )}
            </div>
          )}
          {activeTab === 'splitter' && (
            <SplitterTab />
          )}

          {activeTab === 'settings' && (
            <SettingsTab
              singleWorker={singleWorker}
              setSingleWorker={setSingleWorker}
              enrichmentWorkerCount={enrichmentWorkerCount}
              setEnrichmentWorkerCount={setEnrichmentWorkerCount}
            />
          )}
        </div>
      </div>
    </div>
  );
}
