"use client";

import { useContext, useEffect, useRef } from "react";
import type { WereadBook } from "../lib/weread-types";
import { recordBookExposure } from "../lib/store-snapshot";
import { PageActiveContext } from "../components/sheet";

interface WatchedBook { book: WereadBook; timer?: ReturnType<typeof setTimeout> }
const watched = new Map<Element, WatchedBook>();
let observer: IntersectionObserver | null = null;

function visibilityChanged() {
  for (const [element, item] of watched) {
    clearTimeout(item.timer);
    if (document.visibilityState === "visible") {
      observer?.unobserve(element);
      observer?.observe(element);
    }
  }
}

function watch(element: Element, book: WereadBook) {
  if (typeof IntersectionObserver === "undefined") return () => {};
  if (!watched.size) document.addEventListener("visibilitychange", visibilityChanged);
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const item = watched.get(entry.target);
      if (!item) continue;
      clearTimeout(item.timer);
      if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
      item.timer = setTimeout(() => {
        if (document.visibilityState !== "visible" || entry.target.closest('[inert], [aria-hidden="true"]')) return;
        recordBookExposure(item.book);
      }, 800);
    }
  }, { threshold: [0, 0.5] });
  watched.set(element, { book });
  observer.observe(element);
  return () => {
    clearTimeout(watched.get(element)?.timer);
    watched.delete(element);
    observer?.unobserve(element);
    if (!watched.size) {
      observer?.disconnect(); observer = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
    }
  };
}

export function useBookExposure(book: WereadBook) {
  const ref = useRef<HTMLButtonElement>(null);
  const active = useContext(PageActiveContext);
  useEffect(() => {
    if (active && ref.current) return watch(ref.current, book);
  }, [book, active]);
  return ref;
}
