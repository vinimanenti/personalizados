// Usuários do login. A lista oficial fica no Supabase (stickers/config/users.json) para valer em
// todos os computadores; o localStorage guarda uma cópia para a tela abrir rápido.
// Antes a lista ficava só no navegador de quem criou o usuário, e ninguém mais conseguia entrar.
import { supabase } from "./supabase";

const PATH = "config/users.json";
const DEFAULT_USERS = { admin: { pass: "Vinishow434!", role: "admin" } };

let cache = null;
export const getUsers = () => cache || JSON.parse(localStorage.getItem("ss_users") || JSON.stringify(DEFAULT_USERS));
const remember = users => { cache = users; localStorage.setItem("ss_users", JSON.stringify(users)); };

// Lista do Supabase (null se não houver ou se der erro). `no-store` evita a cópia velha do navegador.
export async function fetchUsersFromDb() {
  if (!supabase) return null;
  try {
    const { data } = supabase.storage.from("stickers").getPublicUrl(PATH);
    const res = await fetch(`${data.publicUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const users = await res.json();
    return users && typeof users === "object" && Object.keys(users).length ? users : null;
  } catch { return null; }
}

// Grava a lista inteira com cache 0 (senão a CDN do Supabase entrega a versão antiga por até 1 h).
// Lança erro se o Supabase recusar — antes o erro era engolido e o usuário parecia criado.
export async function saveUsersToDb(users) {
  if (!supabase) throw new Error("Supabase não configurado neste site");
  const blob = new Blob([JSON.stringify(users)], { type: "application/json" });
  const { error } = await supabase.storage.from("stickers").upload(PATH, blob, { upsert: true, cacheControl: "0", contentType: "application/json" });
  if (error) throw new Error(error.message || String(error));
}

// Busca a lista do Supabase e atualiza a cópia local. Devolve a lista em uso.
export async function refreshUsers() {
  const remote = await fetchUsersFromDb();
  if (remote) remember(remote);
  return getUsers();
}

// Muda a lista partindo da versão mais nova do Supabase (para não apagar usuários criados em
// outro computador) e grava de volta. `change(users)` altera o objeto ou lança erro com a mensagem.
export async function updateUsers(change) {
  const remote = await fetchUsersFromDb();
  const users = { ...(remote || getUsers()) };
  change(users);
  await saveUsersToDb(users);
  remember(users);
  return users;
}
