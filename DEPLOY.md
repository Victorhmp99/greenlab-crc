# Deploy CRC Green Lab — VPS

## 1. Servidor necessário
- Ubuntu 22.04+
- Node.js 22+ (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install nodejs`)
- PM2 (`npm install -g pm2`)
- Nginx (`sudo apt install nginx`)
- Certbot para SSL (`sudo apt install certbot python3-certbot-nginx`)

## 2. Subir os arquivos

```bash
# No seu computador, copia a pasta crc-service para o VPS:
scp -r ./crc-service usuario@IP_VPS:/home/usuario/crc-service
```

## 3. Configurar variáveis de ambiente

```bash
cd /home/usuario/crc-service
cp .env.example .env
nano .env
```

Preencha:
```
PORT=3001
CRC_SECRET=gere_uma_chave_forte_aqui
ALLOWED_ORIGIN=https://seu-crm.vercel.app
NODE_ENV=production
```

## 4. Instalar dependências

```bash
npm install --omit=dev
```

## 5. Iniciar com PM2

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup   # siga as instruções para iniciar no boot
```

## 6. Nginx + SSL

```bash
# Copia e edita a config do nginx
sudo cp nginx.conf.example /etc/nginx/sites-available/crc
sudo nano /etc/nginx/sites-available/crc   # troca seudominio.com.br
sudo ln -s /etc/nginx/sites-available/crc /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Gera certificado SSL gratuito
sudo certbot --nginx -d crc.seudominio.com.br
```

## 7. Atualizar o link no CRM

No arquivo `src/components/layout/Sidebar/index.tsx`:
```tsx
// Troca localhost:3001 pela URL do VPS
href={`https://crc.seudominio.com.br?tenant_id=...`}
```

## 8. Atualizar o secret no CRM

O CRM precisa passar o `x-crc-secret` em todas as chamadas.
Adicione no Supabase Edge Config ou `.env` do CRM:
```
VITE_CRC_SECRET=mesma_chave_do_env_do_crc
VITE_CRC_URL=https://crc.seudominio.com.br
```

E no `Sidebar/index.tsx`:
```tsx
href={`${import.meta.env.VITE_CRC_URL}?tenant_id=...`}
```

## Monitoramento

```bash
pm2 logs crc-greenlab    # logs em tempo real
pm2 monit                # painel de monitoramento
pm2 restart crc-greenlab # reiniciar após atualização
```
