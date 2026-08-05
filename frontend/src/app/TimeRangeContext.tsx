import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export const RANGE_OPTIONS = [
  { value: '7d', label: '7 Tage' },
  { value: '30d', label: '30 Tage' },
  { value: '90d', label: '90 Tage' },
  { value: '365d', label: '365 Tage' },
  { value: 'all', label: 'Alles' },
  { value: 'custom', label: 'Benutzerdefiniert…' },
] as const;

export type RangeValue = '7d' | '30d' | '90d' | '365d' | 'all' | 'custom';

interface TimeRangeContextType {
  selectedRange: RangeValue;
  setSelectedRange: (value: RangeValue) => void;
  customFrom: string;
  setCustomFrom: (value: string) => void;
  customTo: string;
  setCustomTo: (value: string) => void;
  showCustomPicker: boolean;
  setShowCustomPicker: (value: boolean) => void;
  getRangeLabel: (range: RangeValue) => string;
  getDaysFromRange: (range: RangeValue) => number | undefined;
  getFromDate: () => string | undefined;
  getToDate: () => string | undefined;
}

const TimeRangeContext = createContext<TimeRangeContextType | undefined>(undefined);

export function TimeRangeProvider({ children }: { children: ReactNode }) {
  const [selectedRange, setSelectedRange] = useState<RangeValue>(() => {
    const saved = localStorage.getItem('ctl20_timeRange');
    return (saved as RangeValue) || '30d';
  });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustomPicker, setShowCustomPicker] = useState(false);

  // Persist to localStorage
  useEffect(() => {
    localStorage.setItem('ctl20_timeRange', selectedRange);
  }, [selectedRange]);

  const getRangeLabel = (range: RangeValue): string => {
    if (range === 'custom') {
      if (customFrom && customTo) return `${customFrom} – ${customTo}`;
      return 'Benutzerdefiniert';
    }
    const option = RANGE_OPTIONS.find(o => o.value === range);
    return option?.label || range;
  };

  const getDaysFromRange = (range: RangeValue): number | undefined => {
    if (range === 'custom') return undefined;
    if (range === 'all') return 36500; // ~100 years
    const option = RANGE_OPTIONS.find(o => o.value === range);
    if (option?.value) {
      const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
      return daysMap[option.value];
    }
    return undefined;
  };

  const getFromDate = (): string | undefined => {
    return selectedRange === 'custom' && customFrom ? customFrom : undefined;
  };

  const getToDate = (): string | undefined => {
    return selectedRange === 'custom' && customTo ? customTo : undefined;
  };

  const handleRangeChange = (value: RangeValue) => {
    setSelectedRange(value);
    if (value !== 'custom') {
      setShowCustomPicker(false);
      setCustomFrom('');
      setCustomTo('');
    } else {
      setShowCustomPicker(true);
    }
  };

  const handleCustomRangeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customFrom && customTo) {
      setShowCustomPicker(false);
    }
  };

  return (
    <TimeRangeContext.Provider
      value={{
        selectedRange,
        setSelectedRange: handleRangeChange,
        customFrom,
        setCustomFrom,
        customTo,
        setCustomTo,
        showCustomPicker,
        setShowCustomPicker,
        getRangeLabel,
        getDaysFromRange,
        getFromDate,
        getToDate,
      }}
    >
      {children}
    </TimeRangeContext.Provider>
  );
}

export function useTimeRange() {
  const context = useContext(TimeRangeContext);
  if (!context) {
    throw new Error('useTimeRange must be used within a TimeRangeProvider');
  }
  return context;
}
