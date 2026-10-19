# Acervo Bíblico — publicação no GitHub Pages + banco no Supabase

O site é estático (GitHub Pages) e os dados ficam no Supabase, protegidos por login.
Arquivos do site: `index.html`, `style.css`, `app.js`, `config.js`.
`supabase.sql` roda uma vez no Supabase (não precisa ir para o site).

## Antes de tudo: guarde seus dados atuais
Na versão que você usa hoje: **Backup → Exportar backup completo (JSON)**. Guarde esse arquivo.

## 1. Supabase (cerca de 10 minutos)
1. Crie uma conta em supabase.com e um **New project** (anote a senha do banco; escolha a região mais próxima, ex. São Paulo).
2. **SQL Editor → New query**: cole o conteúdo de `supabase.sql` e clique em **Run**. Isso cria as tabelas, as regras de segurança e o espaço das capas.
3. **Authentication → Users → Add user**: crie o **seu** e-mail e senha (marque a opção de confirmar o e-mail automaticamente).
4. **Authentication → Sign In / Providers**: **desligue** "Allow new users to sign up". Assim ninguém além de você consegue criar conta.
5. **Project Settings → API**: copie a **Project URL** e a chave **anon** (ou "publishable") e cole em `config.js`.
   Nunca use a chave `service_role` no site.

## 2. GitHub Pages
1. Crie um repositório **público** no GitHub (ex.: `acervo`). No plano gratuito o Pages só funciona em repositório público; isso não expõe seus dados, que ficam no Supabase.
2. **Add file → Upload files**: envie `index.html`, `style.css`, `app.js` e `config.js` (já preenchido) e faça o commit.
3. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, pasta `/ (root)`. Salve.
4. Em 1 a 2 minutos o site abre em `https://SEU-USUARIO.github.io/acervo/`.
5. No Supabase, em **Authentication → URL Configuration**, coloque esse endereço em *Site URL*.

## 3. Primeiro acesso
1. Abra o site e entre com o e-mail e a senha criados no passo 1.3.
2. **Backup → Restaurar backup JSON e adicionar aos dados atuais** e escolha o arquivo guardado. As capas enviadas por você vão para o Storage automaticamente (pode levar alguns minutos se forem muitas).
3. Se você abrir o site no mesmo navegador/endereço onde guardava os dados antigos, o app oferece enviá-los sozinho, e há o botão "Enviar para a nuvem os dados antigos deste navegador" no Backup.

## Boas práticas
- Continue exportando o backup JSON de vez em quando.
- Projetos gratuitos do Supabase podem ser pausados após um período sem uso; se acontecer, é só reativar no painel.
- As imagens das capas ficam num espaço de leitura pública (quem tiver o endereço exato vê a imagem). Os dados do acervo (preços, empréstimos, notas) só aparecem para você logado.
- Para atualizar o site depois: edite o arquivo no GitHub (ícone de lápis) ou envie de novo; o Pages republica sozinho.
