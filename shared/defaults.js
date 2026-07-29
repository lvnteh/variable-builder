/*
 * shared/defaults.js — the seed variable list.
 *
 * Loaded server-side to seed the SQLite store ONCE when it is empty, so every
 * stakeholder starts from the same 24 "AI Brand Identity" variables instead of
 * each browser seeding its own divergent copy (the old client-side behaviour).
 *
 * Dual-loadable (CommonJS on server, window.VBDefaults in a browser) in case
 * the client ever wants a "reset to defaults" affordance.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VBDefaults = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = [
    // ── Brand Colors ──
    { type: 'color',  display_name: 'Primary Brand Color',   default_value: '#1A1A2E', category: 'AI Brand Identity' },
    { type: 'color',  display_name: 'Secondary Brand Color', default_value: '#E94560', category: 'AI Brand Identity' },
    { type: 'color',  display_name: 'Accent Color',          default_value: '#F5A623', category: 'AI Brand Identity' },
    { type: 'color',  display_name: 'Background Color',      default_value: '#FFFFFF', category: 'AI Brand Identity' },
    // ── Typography Feel ──
    { type: 'select', display_name: 'Typography Style', default_value: 'modern-sans', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'modern-sans',   value: 'modern-sans',   name: 'Modern Sans-serif' },
        { id: 'classic-serif', value: 'classic-serif', name: 'Classic Serif' },
        { id: 'editorial',     value: 'editorial',     name: 'Editorial / Magazine' },
        { id: 'handcrafted',   value: 'handcrafted',   name: 'Handcrafted / Script' },
        { id: 'geometric',     value: 'geometric',     name: 'Geometric / Bauhaus' },
      ] } },
    { type: 'string', display_name: 'Headline Font Name', default_value: 'Helvetica Neue', category: 'AI Brand Identity' },
    { type: 'string', display_name: 'Body Font Name',     default_value: 'Georgia',        category: 'AI Brand Identity' },
    // ── Visual Tone ──
    { type: 'select', display_name: 'Visual Tone', default_value: 'aspirational', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'aspirational', value: 'aspirational', name: 'Aspirational / Luxury' },
        { id: 'playful',      value: 'playful',      name: 'Playful / Energetic' },
        { id: 'minimal',      value: 'minimal',      name: 'Minimal / Clean' },
        { id: 'warm-organic', value: 'warm-organic', name: 'Warm / Organic' },
        { id: 'bold-graphic', value: 'bold-graphic', name: 'Bold / Graphic' },
        { id: 'technical',    value: 'technical',    name: 'Technical / Precise' },
      ] } },
    { type: 'select', display_name: 'Mood', default_value: 'confident', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'confident',   value: 'confident',   name: 'Confident' },
        { id: 'friendly',    value: 'friendly',    name: 'Friendly' },
        { id: 'mysterious',  value: 'mysterious',  name: 'Mysterious' },
        { id: 'fresh',       value: 'fresh',       name: 'Fresh / Youthful' },
        { id: 'trustworthy', value: 'trustworthy', name: 'Trustworthy / Safe' },
        { id: 'premium',     value: 'premium',     name: 'Premium / Exclusive' },
      ] } },
    // ── Photography Style ──
    { type: 'select', display_name: 'Lighting Style', default_value: 'soft-natural', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'soft-natural', value: 'soft-natural', name: 'Soft Natural Light' },
        { id: 'studio-clean', value: 'studio-clean', name: 'Clean Studio Light' },
        { id: 'dramatic',     value: 'dramatic',     name: 'Dramatic / High Contrast' },
        { id: 'golden-hour',  value: 'golden-hour',  name: 'Golden Hour / Warm' },
        { id: 'flat-lay',     value: 'flat-lay',     name: 'Flat Lay / Overhead' },
      ] } },
    { type: 'select', display_name: 'Background Style', default_value: 'clean-white', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'clean-white',   value: 'clean-white',   name: 'Clean White' },
        { id: 'lifestyle-env', value: 'lifestyle-env', name: 'Lifestyle Environment' },
        { id: 'textured',      value: 'textured',      name: 'Textured / Organic' },
        { id: 'gradient',      value: 'gradient',      name: 'Gradient' },
        { id: 'brand-color',   value: 'brand-color',   name: 'Brand Color Fill' },
        { id: 'transparent',   value: 'transparent',   name: 'Transparent / Cut-out' },
      ] } },
    { type: 'select', display_name: 'Shot Type', default_value: 'hero-product', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'hero-product', value: 'hero-product', name: 'Hero Product Shot' },
        { id: 'lifestyle',    value: 'lifestyle',    name: 'Lifestyle In-use' },
        { id: 'detail-macro', value: 'detail-macro', name: 'Detail / Macro' },
        { id: 'group-flat',   value: 'group-flat',   name: 'Group / Collection' },
        { id: 'model-worn',   value: 'model-worn',   name: 'Model / Worn' },
      ] } },
    // ── Composition ──
    { type: 'select', display_name: 'Composition Style', default_value: 'centered', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'centered',    value: 'centered',    name: 'Centered / Symmetrical' },
        { id: 'rule-thirds', value: 'rule-thirds', name: 'Rule of Thirds' },
        { id: 'asymmetric',  value: 'asymmetric',  name: 'Asymmetric / Dynamic' },
        { id: 'minimal-neg', value: 'minimal-neg', name: 'Minimal Negative Space' },
        { id: 'edge-bleed',  value: 'edge-bleed',  name: 'Edge Bleed / Cropped' },
      ] } },
    { type: 'select', display_name: 'Aspect Ratio', default_value: '1:1', category: 'AI Brand Identity',
      type_config: { options: [
        { id: '1:1',  value: '1:1',  name: '1:1 Square' },
        { id: '4:5',  value: '4:5',  name: '4:5 Portrait (Instagram)' },
        { id: '9:16', value: '9:16', name: '9:16 Story / Reel' },
        { id: '16:9', value: '16:9', name: '16:9 Landscape / Banner' },
        { id: '3:4',  value: '3:4',  name: '3:4 Portrait' },
      ] } },
    // ── Brand Persona ──
    { type: 'string', display_name: 'Brand Name',    default_value: '', category: 'AI Brand Identity' },
    { type: 'string', display_name: 'Brand Tagline', default_value: '', category: 'AI Brand Identity' },
    { type: 'select', display_name: 'Target Audience', default_value: 'millennials-urban', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'millennials-urban', value: 'millennials-urban', name: 'Millennials Urban' },
        { id: 'gen-z',             value: 'gen-z',             name: 'Gen Z' },
        { id: 'affluent-adult',    value: 'affluent-adult',    name: 'Affluent Adults' },
        { id: 'young-family',      value: 'young-family',      name: 'Young Families' },
        { id: 'professional',      value: 'professional',      name: 'Professionals / B2B' },
        { id: 'active-lifestyle',  value: 'active-lifestyle',  name: 'Active Lifestyle' },
      ] } },
    { type: 'select', display_name: 'Market Positioning', default_value: 'mid-premium', category: 'AI Brand Identity',
      type_config: { options: [
        { id: 'budget',      value: 'budget',      name: 'Value / Budget' },
        { id: 'mid-market',  value: 'mid-market',  name: 'Mid-market' },
        { id: 'mid-premium', value: 'mid-premium', name: 'Mid-premium' },
        { id: 'luxury',      value: 'luxury',      name: 'Luxury / High-end' },
      ] } },
    // ── Image Generation Prompt Modifiers ──
    { type: 'string', display_name: 'Style Keywords',            default_value: 'clean, modern, premium',            category: 'AI Brand Identity' },
    { type: 'string', display_name: 'Avoid Keywords',            default_value: 'cluttered, low quality, dark',      category: 'AI Brand Identity' },
    { type: 'string', display_name: 'Color Palette Description', default_value: 'neutral whites with deep navy accents', category: 'AI Brand Identity' },
  ];

  return DEFAULTS;
});
