import os
from dotenv import load_dotenv
from google import genai

# Força o carregamento do arquivo .env que está na mesma pasta deste script
diretorio_atual = os.path.dirname(os.path.abspath(__file__))
caminho_env = os.path.join(diretorio_atual, '.env')

print(f"🔍 Verificando arquivo em: {caminho_env}")

if os.path.exists(caminho_env):
    print("✅ Arquivo .env encontrado!")
    load_dotenv(caminho_env, override=True)
else:
    print("❌ Arquivo .env NÃO foi encontrado nesta pasta!")

# Tenta ler a chave
CHAVE_API = os.getenv("GEMINI_API_KEY")

def testar_conexao():
    if not CHAVE_API:
        print("❌ Erro: A variável GEMINI_API_KEY está vazia ou não foi carregada.")
        # Lista o que o Python conseguiu ler para ajudar a descobrir o erro
        return

    print("🚀 Tentando conectar com Gemini 2.0 Flash...")
    try:
        client = genai.Client(api_key=CHAVE_API)
        response = client.models.generate_content(
            model="gemini-2.0-flash", 
            contents="Responda apenas: 'Conexão estabelecida com sucesso!'"
        )
        print(f"\n🤖 RESPOSTA: {response.text}")
        print("\n✅ TUDO PRONTO!")
    except Exception as e:
        print(f"\n❌ Erro na API: {e}")

if __name__ == "__main__":
    testar_conexao()