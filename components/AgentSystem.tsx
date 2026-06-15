'use client';

import { motion } from 'framer-motion';
import { Brain, Eye, Layout, Server, Database, Cloud, Shield, Zap, CheckCircle, Bug, Wrench, Rocket, Palette, Search, Code } from 'lucide-react';
import { AGENTS, SUPREME_BRAIN } from '@/lib/agents';

const iconMap: Record<string, React.ElementType> = {
  eye: Eye, layout: Layout, server: Server, database: Database,
  cloud: Cloud, shield: Shield, zap: Zap, check: CheckCircle,
  bug: Bug, wrench: Wrench, rocket: Rocket, brain: Brain,
  palette: Palette, search: Search, code: Code,
};

export function AgentSystem() {
  return (
    <section id="agents" className="py-24 relative circuit-bg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            Multi-Agent <span className="gradient-text">AI System</span>
          </h2>
          <p className="text-white/60 text-lg max-w-2xl mx-auto">
            Supreme Brain coordinates 15 specialized agents for unmatched software generation.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          className="glass-strong rounded-3xl p-8 mb-12 border-shark-cyan/20 relative overflow-hidden"
        >
          <div className="absolute inset-0 bg-shark-gradient opacity-5" />
          <div className="relative flex flex-col md:flex-row items-center gap-6">
            <div className="w-20 h-20 rounded-2xl bg-shark-gradient flex items-center justify-center shadow-glow">
              <Brain className="w-10 h-10 text-white" />
            </div>
            <div className="text-center md:text-left">
              <h3 className="font-display text-2xl font-bold gradient-text mb-2">
                {SUPREME_BRAIN.name}
              </h3>
              <p className="text-shark-cyan font-medium mb-1">{SUPREME_BRAIN.role}</p>
              <p className="text-white/60">{SUPREME_BRAIN.description}</p>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {AGENTS.map((agent, i) => {
            const Icon = iconMap[agent.icon] || Brain;
            return (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.04 }}
                className="glass rounded-xl p-4 hover:border-shark-purple/30 transition-all group"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center group-hover:bg-shark-gradient transition-colors">
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-xs text-shark-cyan font-mono">{agent.id}</span>
                </div>
                <h4 className="font-semibold text-sm mb-1">{agent.name}</h4>
                <p className="text-xs text-white/40">{agent.description}</p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
