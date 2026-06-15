'use client';

import { motion } from 'framer-motion';
import { AUTONOMOUS_LOOP } from '@/lib/agents';
import { RefreshCw } from 'lucide-react';

export function AutonomousLoop() {
  return (
    <section id="loop" className="py-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            <span className="gradient-text">Autonomous Loop</span>
          </h2>
          <p className="text-white/60 text-lg max-w-2xl mx-auto">
            Continuous improvement until quality exceeds target score — fully automated.
          </p>
        </motion.div>

        <div className="relative">
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-0.5 bg-gradient-to-r from-shark-cyan via-shark-blue to-shark-purple opacity-30 -translate-y-1/2" />

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4">
            {AUTONOMOUS_LOOP.map((step, i) => (
              <motion.div
                key={step.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
                className="glass rounded-2xl p-4 text-center hover:border-shark-cyan/40 transition-all relative"
              >
                <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-shark-gradient flex items-center justify-center text-sm font-bold">
                  {i + 1}
                </div>
                <h4 className="font-semibold text-sm mb-1">{step.label}</h4>
                <p className="text-xs text-white/40 hidden sm:block">{step.description}</p>
              </motion.div>
            ))}
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="flex items-center justify-center gap-3 mt-12 text-white/50"
          >
            <RefreshCw className="w-5 h-5 text-shark-cyan animate-spin" style={{ animationDuration: '3s' }} />
            <span className="text-sm">Repeats until quality score ≥ 95</span>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
