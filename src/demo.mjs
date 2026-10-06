import { sleep, checkAbort } from './core.mjs';

export function createDemoClient() {
  const names = [
    ['ada.kare', 'Ada Yılmaz'], ['mert.studio', 'Mert Demir'], ['eceyollarda', 'Ece Aydın'], ['deniz.analog', 'Deniz Kaya'],
    ['selin.design', 'Selin Arslan'], ['keremnotlar', 'Kerem Çelik'], ['duru.atolye', 'Duru Aksoy'], ['emre.wav', 'Emre Şahin'],
    ['zeynep.co', 'Zeynep Koç'], ['baris.rotasi', 'Barış Yıldız'], ['elif.ciziyor', 'Elif Güneş'], ['can.digital', 'Can Eren'],
    ['flora.gunluk', 'Flora Günlük'], ['atlas.collective', 'Atlas Collective'], ['kahve.arasi', 'Kahve Arası'], ['pazar.studio', 'Pazar Studio'],
    ['yasam.notlari', 'Yaşam Notları'], ['aylin.jpg', 'Aylin Deniz'], ['burak.frames', 'Burak Arda'], ['seda.mutfak', 'Seda Mutlu'],
    ['utku.visual', 'Utku Can'], ['nazli.reads', 'Nazlı Işık'], ['onur.onroad', 'Onur Öztürk'], ['ipek.objects', 'İpek Tekin']
  ];
  const all = Array.from({ length: 128 }, (_, i) => {
    const [handle, name] = names[i % names.length], suffix = i < names.length ? '' : `_${Math.floor(i / names.length) + 1}`;
    return { id: String(100000 + i), username: handle + suffix, full_name: name,
      is_private: i % 3 === 0, is_verified: i % 11 === 0 };
  });
  let following = all.slice(0, 96);
  const followers = all.filter((_, i) => i >= 32 && i < 120);
  const snapshot = () => ({ accountId: 'demo', scannedAt: Date.now(), complete: true,
    following: structuredClone(following), followers: structuredClone(followers) });
  return {
    accountId: 'demo', snapshot,
    async scan(signal, progress) {
      for (const kind of ['followers', 'following']) {
        for (const count of [32, 64, kind === 'followers' ? 88 : following.length]) {
          await sleep(230, signal); progress({ kind, count, page: Math.ceil(count / 32) });
        }
      }
      return snapshot();
    },
    async relation(id, signal) { checkAbort(signal); await sleep(130, signal);
      return { following: following.some(u => u.id === id), followed_by: followers.some(u => u.id === id) }; },
    async unfollow(id, signal, beforeSend) { checkAbort(signal); beforeSend?.(); await sleep(300, signal); following = following.filter(u => u.id !== id); }
  };
}