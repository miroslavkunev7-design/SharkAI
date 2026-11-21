'use client';

import React, { type FormEvent, type MouseEvent, type ReactNode } from 'react';

function openWalletWindow() {
  const width=Math.min(520,window.screen.availWidth);
  const height=Math.min(740,window.screen.availHeight);
  const popup=window.open('about:blank','_blank',`popup,width=${width},height=${height}`);
  if (popup) popup.opener=null;
  return popup;
}

export function WiseWindowLink({className,children}:{className:string;children:ReactNode}) {
  function open(event:MouseEvent<HTMLAnchorElement>) {
    if(event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.button!==0)return;
    const popup=openWalletWindow();
    if(!popup)return;
    event.preventDefault();
    popup.location.replace(event.currentTarget.href);
  }
  return <a href="https://wise.com/home/" target="_blank" rel="noopener noreferrer" title="Отваря Wise в отделен прозорец" className={className} onClick={open}>{children}</a>;
}

export function WiseReviewForm({className,children}:{className:string;children:ReactNode}) {
  function open(event:FormEvent<HTMLFormElement>) {
    const popup=openWalletWindow();
    if(!popup)return; // Submit in this tab when the browser blocks the window.
    const form=popup.document.createElement('form');
    form.method='POST';
    form.action=event.currentTarget.action;
    popup.document.body.appendChild(form);
    event.preventDefault();
    window.addEventListener('focus',()=>window.dispatchEvent(new Event('sharkai:wise-return')),{once:true});
    form.submit();
  }
  return <form method="POST" action="/api/wallet-investments/provider/onboarding" onSubmit={open}>
    <button className={className} type="submit">{children}</button>
  </form>;
}
