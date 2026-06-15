'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Monitor, Smartphone, Laptop, Cloud, Gamepad2, MessageSquare,
  Mic, Video, Figma, FileText, Database, Code2, Bug, Rocket,
  BookOpen, CheckCircle, Shield,
} from 'lucide-react';
import { FEATURES } from '@/lib/agents';

const iconMap: Record<string, React.ElementType> = {
  monitor: Monitor,
  smartphone: Smartphone,
  laptop: Laptop,
  cloud: Cloud,
  gamepad: Gamepad2,
  message: MessageSquare,
  mic: Mic,
  video: Video,
  figma: Figma,
  file: FileText,
  database: Database,
  api: Code2,
  bug: Bug,
  code: Code2,
  rocket: Rocket,
  book: BookOpen,
  check: CheckCircle,
  shield: Shield,
};

export function Features() {
  return (
    <section id="features" className="py-24 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            <span className="gradient-text">18 Powerful Features</span>
          </h2>
          <p className="text-white/60 text-lg max-w-2xl mx-auto">
            From screenshot to production — every input type, every platform, fully automated.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((feature, i) => {
            const Icon = iconMap[feature.icon] || Code2;
            return (
              <Link key={feature.id} href={`/dashboard?feature=${feature.id}`}>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="glass rounded-2xl p-6 hover:border-shark-cyan/30 transition-all duration-300 group cursor-pointer h-full"
              >
                <div className="w-12 h-12 rounded-xl bg-shark-gradient flex items-center justify-center mb-4 group-hover:shadow-glow transition-shadow">
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="font-semibold text-lg mb-2">{feature.title}</h3>
                <p className="text-sm text-white/50">
                  {feature.subtitle}
                </p>
              </motion.div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
