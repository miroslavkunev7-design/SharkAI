'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Check, Crown, Zap } from 'lucide-react';
import { PLANS } from '@/lib/agents';

export function Pricing() {
  return (
    <section id="pricing" className="py-24 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            Simple <span className="gradient-text">Pricing</span>
          </h2>
          <p className="text-white/60 text-lg">
            Stripe · PayPal · Apple Pay · Google Pay
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {Object.entries(PLANS).map(([key, plan], i) => (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className={`rounded-3xl p-8 relative ${
                'popular' in plan && plan.popular
                  ? 'glass-strong border-shark-cyan/30 shadow-glow'
                  : 'glass'
              }`}
            >
              {'popular' in plan && plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-shark-gradient px-4 py-1 rounded-full text-sm font-semibold flex items-center gap-1">
                  <Crown className="w-4 h-4" /> Most Popular
                </div>
              )}

              <div className="flex items-center gap-3 mb-6">
                {key === 'ULTRA' ? (
                  <Zap className="w-8 h-8 text-shark-purple" />
                ) : (
                  <Check className="w-8 h-8 text-shark-cyan" />
                )}
                <h3 className="font-display text-2xl font-bold">{plan.name}</h3>
              </div>

              <div className="mb-8">
                <span className="text-5xl font-bold gradient-text">{plan.price}</span>
                <span className="text-white/50 ml-2">{plan.currency}/month</span>
              </div>

              <ul className="space-y-3 mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm text-white/70">
                    <Check className="w-5 h-5 text-shark-cyan shrink-0 mt-0.5" />
                    {feature}
                  </li>
                ))}
              </ul>

              <Link
                href={`/pricing?plan=${key.toLowerCase()}`}
                className={key === 'ULTRA' ? 'btn-primary w-full text-center block' : 'btn-secondary w-full text-center block'}
              >
                Get {plan.name}
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
