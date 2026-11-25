"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { platformApi } from "./billingWords";

// Load one operator API URL; reload() fetches it again; a newer load wins over
// an older one still in flight. -> { loading, error, data, reload, setData }
export function useBillingData(url) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await platformApi(url);
      if (id === seq.current) setState({ loading: false, error: null, data });
    } catch (e) {
      if (id === seq.current) setState((s) => ({ loading: false, error: String(e?.message || e), data: s.data }));
    }
  }, [url]);
  useEffect(() => {
    reload();
  }, [reload]);
  const setData = useCallback((data) => setState({ loading: false, error: null, data }), []);
  return { ...state, reload, setData };
}
