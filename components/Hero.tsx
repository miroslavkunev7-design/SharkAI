'use client';

import Link from 'next/link';
import { Logo } from './Logo';
import { motion } from 'framer-motion';
import { ArrowRight, Sparkles, Zap, Download } from 'lucide-react';

export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center pt-20 overflow-hidden circuit-bg">
      <div className="absolute inset-0 bg-hero-glow pointer-events-none" />
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-shark-blue/10 rounded-full blur-3xl animate-pulse-glow" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-shark-purple/10 rounded-full blur-3xl animate-pulse-glow" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className="inline-flex items-center gap-2 glass rounded-full px-4 py-2 mb-6">
              <Sparkles className="w-4 h-4 text-shark-cyan" />
              <span className="text-sm text-white/80">
                15 AI Agents · Supreme Brain Architecture
              </span>
            </div>

            <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold leading-tight mb-6">
              Build Anything with{' '}
              <span className="gradient-text">Autonomous AI</span>
            </h1>

            <p className="text-lg sm:text-xl text-white/60 mb-8 max-w-xl leading-relaxed">
              Generate production-ready websites, SaaS platforms, mobile apps,
              desktop software, games and complete businesses from prompts,
              screenshots, videos and voice commands.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 mb-10">
              <Link href="/download" className="btn-primary inline-flex items-center justify-center gap-2">
                <Download className="w-5 h-5" />
                Download SharkAI — Шарк АИ
              </Link>
              <Link href="/chat" className="btn-secondary inline-flex items-center justify-center gap-2">
                Open Chat
                <ArrowRight className="w-5 h-5" />
              </Link>
              <Link href="/dashboard" className="btn-secondary inline-flex items-center justify-center gap-2">
                <Zap className="w-5 h-5 text-shark-cyan" />
                Studio
              </Link>
            </div>

            <div className="flex flex-wrap gap-6 text-sm text-white/50">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-shark-cyan animate-pulse" />
                99% Design Accuracy
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-shark-blue animate-pulse" />
                95+ Code Quality
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-shark-purple animate-pulse" />
                Auto Deploy
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="relative flex justify-center"
          >
            <div className="relative animate-float">
              <div className="absolute inset-0 bg-shark-gradient blur-3xl opacity-15 scale-110" />
              <Logo
                size="xl"
                variant="full"
                priority
                className="relative z-10 drop-shadow-[0_0_40px_rgba(0,114,255,0.4)] w-full max-w-md h-auto"
              />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
