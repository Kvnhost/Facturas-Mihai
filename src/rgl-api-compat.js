
/*
 * RGL MIHAI - API Compatibility Layer
 * Adaptador entre la web original y Cloudflare Workers + D1.
 * No utiliza Supabase.
 */

(() => {
  "use strict";

  // Evitar inicializaciones duplicadas.
  if (window.rglApi) {
    console.warn("[RGL] La API ya está inicializada.");
    return;
  }

  const listeners = [];

  /**
   * Petición al backend.
   */
  const request = async (path, body = undefined) => {
    const options = {
      method: body !== undefined ? "POST" : "GET",
      credentials: "same-origin",
      headers: {
        "Accept": "application/json"
      }
    };

    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    let response;

    try {
      response = await fetch(path, options);
    } catch (error) {
      console.error("[RGL] Error de conexión:", error);
      throw new Error(
        "No se pudo conectar con el servidor. Comprueba tu conexión."
      );
    }

    let result;

    try {
      result = await response.json();
    } catch {
      throw new Error(
        `El servidor devolvió una respuesta no válida (${response.status}).`
      );
    }

    if (!response.ok) {
      throw new Error(
        result?.error ||
        result?.message ||
        `Error del servidor (${response.status}).`
      );
    }

    return result;
  };

  /**
   * Ejecuta los eventos de autenticación.
   */
  const notifyAuth = (event, session) => {
    listeners.slice().forEach((callback) => {
      try {
        callback(event, session);
      } catch (error) {
        console.error("[RGL] Error en listener:", error);
      }
    });
  };

  /**
   * Constructor de consultas.
   */
  class Query {
    constructor(table) {
      this.table = table;
      this.action = "select";
      this.filters = [];
      this.orderBy = null;
      this.max = 1000;
      this.payload = null;
      this.columns = "*";
      this.singleMode = null;
    }

    select(columns = "*") {
      this.columns = columns;
      return this;
    }

    insert(data) {
      this.action = "insert";
      this.payload = data;
      return this;
    }

    update(data) {
      this.action = "update";
      this.payload = data;
      return this;
    }

    delete() {
      this.action = "delete";
      return this;
    }

    eq(column, value) {
      this.filters.push({
        column,
        op: "eq",
        value
      });
      return this;
    }

    order(column, options = {}) {
      this.orderBy = {
        column,
        ascending: options.ascending !== false
      };
      return this;
    }

    limit(number) {
      const value = Number(number);

      if (!Number.isInteger(value) || value < 0) {
        throw new Error("El límite de consulta no es válido.");
      }

      this.max = value;
      return this;
    }

    single() {
      this.singleMode = "single";
      return this.execute();
    }

    maybeSingle() {
      this.singleMode = "maybeSingle";
      return this.execute();
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    catch(reject) {
      return this.execute().catch(reject);
    }

    finally(callback) {
      return this.execute().finally(callback);
    }

    async execute() {
      try {
        if (!this.table || typeof this.table !== "string") {
          throw new Error("Nombre de tabla no válido.");
        }

        const result = await request("/api/query", {
          table: this.table,
          action: this.action,
          payload: this.payload,
          filters: this.filters,
          order: this.orderBy,
          limit: this.max,
          columns: this.columns
        });

        let data = result.data;

        if (this.singleMode) {
          if (Array.isArray(data)) {
            if (this.singleMode === "single" && data.length !== 1) {
              throw new Error(
                data.length === 0
                  ? "No se encontró el registro solicitado."
                  : "Se encontraron varios registros."
              );
            }

            data = data[0] ?? null;
          }

          if (
            this.singleMode === "single" &&
            data === null
          ) {
            throw new Error("No se encontró el registro solicitado.");
          }
        }

        return {
          data,
          error: null
        };

      } catch (error) {
        console.error("[RGL] Error en consulta:", error);

        return {
          data: null,
          error: {
            message: error.message || "Error al consultar la base de datos."
          }
        };
      }
    }
  }

  /**
   * Autenticación.
   */
  const auth = {
    signInWithPassword: async ({ email, password } = {}) => {
      try {
        if (!email || !password) {
          throw new Error("Introduce el correo y la contraseña.");
        }

        const result = await request("/api/login", {
          email: String(email).trim(),
          password: String(password)
        });

        const session = result.user
          ? { user: result.user }
          : null;

        notifyAuth("SIGNED_IN", session);

        return {
          data: {
            user: result.user || null,
            session
          },
          error: null
        };

      } catch (error) {
        return {
          data: {
            user: null,
            session: null
          },
          error: {
            message: error.message
          }
        };
      }
    },

    signOut: async () => {
      try {
        await request("/api/logout", {});

        notifyAuth("SIGNED_OUT", null);

        return {
          error: null
        };

      } catch (error) {
        return {
          error: {
            message: error.message
          }
        };
      }
    },

    getSession: async () => {
      try {
        const result = await request("/api/me");

        const session = result.user
          ? { user: result.user }
          : null;

        return {
          data: { session },
          error: null
        };

      } catch (error) {
        return {
          data: { session: null },
          error: {
            message: error.message
          }
        };
      }
    },

    getUser: async () => {
      try {
        const result = await request("/api/me");

        return {
          data: {
            user: result.user || null
          },
          error: null
        };

      } catch (error) {
        return {
          data: { user: null },
          error: {
            message: error.message
          }
        };
      }
    },

    onAuthStateChange: (callback) => {
      if (typeof callback !== "function") {
        throw new Error("El callback de autenticación no es válido.");
      }

      listeners.push(callback);

      return {
        data: {
          subscription: {
            unsubscribe() {
              const index = listeners.indexOf(callback);

              if (index !== -1) {
                listeners.splice(index, 1);
              }
            }
          }
        }
      };
    }
  };

  /**
   * API pública.
   */
  window.rglApi = {
    createClient() {
      return {
        from(table) {
          return new Query(table);
        },
        auth
      };
    }
  };

  console.info("[RGL] API de compatibilidad inicializada correctamente.");

})();
