'use client';

import React, { useState } from 'react';
import { Upload, Download, Play, AlertCircle, CheckCircle, Loader } from 'lucide-react';

interface BusinessResult {
  stadt: string;
  branche: string;
  name?: string;
  adresse?: string;
  telefon?: string;
  website?: string;
  email?: string;
  owner?: string;
  status?: string;
}

type Language = 'de' | 'en';

const translations = {
  de: {
    title: 'Local Business Scraper',
    subtitle: 'Scrape Tausende lokale Unternehmen nach Stadt und Branche.',
    uploadLabel: 'Excel- oder CSV-Datei hochladen mit den Spalten "Stadt" und "Branche":',
    uploadPlaceholder: 'Zum Hochladen klicken oder Datei hier ablegen',
    uploadError: 'Bitte nur Excel- oder CSV-Dateien hochladen',
    settings: 'Einstellungen',
    searchEmail: 'Email-Adressen suchen',
    searchOwner: 'Geschäftsführer suchen',
    country: 'Land',
    maxBusinesses: 'Maximale Unternehmen pro Suche',
    startButton: 'Scraping starten',
    processing: 'Verarbeitung läuft...',
    leads: 'Leads',
    results: 'Ergebnisse',
    download: 'CSV Download',
    city: 'Stadt',
    industry: 'Branche',
    name: 'Name',
    email: 'Email',
    owner: 'Geschäftsführer',
    status: 'Status',
    howItWorks: 'So funktioniert es:',
    step1: 'Excel- oder CSV-Datei mit den Spalten "Stadt" und "Branche" hochladen',
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
    uploadLabel: 'Upload Excel or CSV File with the columns "city" and "industry":',
    uploadPlaceholder: 'Click to upload or drag file here',
    uploadError: 'Please upload only Excel or CSV files',
    settings: 'Settings',
    searchEmail: 'Search for emails',
    searchOwner: 'Search for business owners',
    country: 'Country',
    maxBusinesses: 'Max businesses per search',
    startButton: 'Start Scraping',
    processing: 'Processing...',
    leads: 'Leads',
    results: 'Results',
    download: 'CSV Download',
    city: 'City',
    industry: 'Industry',
    name: 'Name',
    email: 'Email',
    owner: 'Owner',
    status: 'Status',
    howItWorks: 'How it works:',
    step1: 'Upload Excel or CSV file with columns "city" and "industry"',
    step2: 'Get a coffee',
    step3: 'Download results as CSV',
    fileRequired: 'Please upload a file first',
    scrapingFailed: 'Scraping failed',
    errorOccurred: 'An error occurred',
    run: 'Run',
    of: 'of',
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
  const [searchOwner, setSearchOwner] = useState(true);
  const [country, setCountry] = useState('de');
  const [maxBusinesses, setMaxBusinesses] = useState<number | 'max'>(100);

  const t = translations[language];

  // Detect browser language after component mounts (client-side only)
  React.useEffect(() => {
    const browserLang = navigator.language.toLowerCase();
    const detectedLang = browserLang.startsWith('de') ? 'de' : 'en';
    setLanguage(detectedLang);
  }, []);

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
    setProgress({ current: 0, total: 0, status: 'Starte...', searchCount: 0, totalSearches: 0 });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('searchEmail', String(searchEmail));
    formData.append('searchOwner', String(searchOwner));
    formData.append('country', country);
    formData.append('maxBusinesses', String(maxBusinesses));

    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(t.scrapingFailed);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      const tempResults: BusinessResult[] = [];

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
              
              if (data.type === 'progress') {
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
                setResults(data.results);
                setProgress({
                  current: data.results.length,
                  total: data.results.length,
                  status: data.message,
                  searchCount: 0,
                  totalSearches: 0,
                });
              } else if (data.type === 'error') {
                setError(data.message);
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errorOccurred);
    } finally {
      setProcessing(false);
    }
  };

  const downloadResults = () => {
    if (!results) return;

    const csv = [
      [t.city, t.industry, t.name, 'Address', 'Phone', 'Website', t.email, t.owner, t.status].join(','),
      ...results.map((r: BusinessResult) => [
        r.stadt,
        r.branche,
        r.name || '',
        r.adresse || '',
        r.telefon || '',
        r.website || '',
        r.email || '',
        r.owner || '',
        r.status || ''
      ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `scraping_ergebnisse_${Date.now()}.csv`;
    link.click();
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-4xl mx-auto">
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
                    min="20"
                    step="20"
                    value={maxBusinesses === 'max' ? '' : maxBusinesses}
                    onChange={(e) => {
                      const value = e.target.value;
                      setMaxBusinesses(value === '' ? 'max' : parseInt(value) || 20);
                    }}
                    disabled={maxBusinesses === 'max'}
                    className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="20, 40, 60..."
                  />
                  <button
                    onClick={() => setMaxBusinesses(maxBusinesses === 'max' ? 100 : 'max')}
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
            </div>
          </div>

          {/* Start Button */}
          <button
            onClick={startScraping}
            disabled={!file || processing}
            className="w-full bg-indigo-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
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
                <button
                  onClick={downloadResults}
                  className="bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition-colors flex items-center"
                >
                  <Download className="w-4 h-4 mr-2" />
                  {t.download}
                </button>
              </div>
              
              <div className="overflow-auto max-h-96 border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold">{t.city}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.industry}</th>
                      <th className="px-4 py-2 text-left font-semibold">{t.name}</th>
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
        </div>
      </div>
    </div>
  );
}
